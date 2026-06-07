let exams = [];
let liveStudents = {}; 
let currentLiveExamId = null;
let currentFullscreenSessionId = null;
let currentSessionsList = [];
let socket = io();

async function apiFetch(url, options = {}) {
    const res = await fetch(url, options);
    if (res.status === 403) {
        const clone = res.clone();
        try {
            const data = await clone.json();
            if (data.needs_passcode) {
                sessionStorage.removeItem('dashboard_passcode_verified');
                document.getElementById('passcode-overlay').style.display = 'flex';
                document.getElementById('app').style.display = 'none';
                throw new Error('Passcode verification required');
            }
        } catch(e) {
            // Ignore parse error
        }
    }
    return res;
}

socket.on('snapshot_update', (data) => {
    // data: { exam_id, exam_session_id, student_canvas_id, screenshot_data_url }
    if(currentLiveExamId == data.exam_id) {
        liveStudents[data.exam_session_id] = { ...liveStudents[data.exam_session_id], screenshot: data.screenshot_data_url };
        updateLiveGrid();
        
        // Dynamically update the fullscreen modal in real-time acting as a live feed!
        if (currentFullscreenSessionId == data.exam_session_id) {
            document.getElementById('fullscreen-image').src = data.screenshot_data_url;
        }
    }
});

socket.on('student_status', (data) => {
    // data: { session_id, name, status }
    if(currentLiveExamId) {
        if(!liveStudents[data.session_id]) liveStudents[data.session_id] = { name: data.name };
        liveStudents[data.session_id].status = data.status;
        updateLiveGrid();
    }
});

socket.on('proctor_log', (data) => {
    showToast(`Alert: ${data.event_message}`, 'warning');
    
    if (currentLiveExamId && liveStudents[data.exam_session_id]) {
        const s = liveStudents[data.exam_session_id];
        if (!s.flagCount) s.flagCount = 0;
        
        const isFlag = ['tab_blur', 'window_blur', 'fullscreen_exit', 'error', 'fail'].includes(data.event_type) || data.event_type.startsWith('AI_');
        if (isFlag) {
            s.flagCount++;
            s.hasFlags = true;
            
            // Update Flagged Warnings counter in header
            const flagsValEl = document.getElementById('stat-flagged-violations');
            if (flagsValEl) {
                const curr = parseInt(flagsValEl.innerText) || 0;
                flagsValEl.innerText = curr + 1;
            }
        }
        updateLiveGrid();
    }
});

document.addEventListener('DOMContentLoaded', () => {
    checkDatabaseCapacity();
    if (sessionStorage.getItem('dashboard_passcode_verified') === 'true') {
        document.getElementById('passcode-overlay').style.display = 'none';
        document.getElementById('app').style.display = '';
        loadExams();
    } else {
        document.getElementById('passcode-overlay').style.display = 'flex';
        document.getElementById('app').style.display = 'none';
    }
});

async function submitPasscode() {
    const passcode = document.getElementById('passcode-input').value;
    const errorEl = document.getElementById('passcode-error-msg');
    errorEl.style.display = 'none';
    
    try {
        const res = await fetch('/api/verify-passcode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ passcode })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            sessionStorage.setItem('dashboard_passcode_verified', 'true');
            document.getElementById('passcode-overlay').style.display = 'none';
            document.getElementById('app').style.display = '';
            loadExams();
        } else {
            errorEl.innerText = data.error || 'Incorrect passcode';
            errorEl.style.display = 'block';
        }
    } catch (err) {
        errorEl.innerText = 'Connection error';
        errorEl.style.display = 'block';
    }
}

async function checkDatabaseCapacity() {
    try {
        const res = await apiFetch('/api/db-status');
        const data = await res.json();
        const mbUsed = data.used_bytes / 1024 / 1024;
        if (mbUsed > 350) {
            const banner = document.createElement('div');
            banner.style.background = 'var(--danger)';
            banner.style.color = 'white';
            banner.style.padding = '12px 20px';
            banner.style.textAlign = 'center';
            banner.style.fontWeight = 'bold';
            banner.innerHTML = `⚠️ CRITICAL: Database Storage Running Low! (${mbUsed.toFixed(1)} MB / 500 MB limit). Please download and purge older recordings immediately to prevent data loss.`;
            document.body.insertBefore(banner, document.body.firstChild);
        }
    } catch(err) {
        console.error("Capacity check failed", err);
    }
}

let urlParams = new URLSearchParams(window.location.search);
let activeResourceLinkId = urlParams.get('resource_link_id');
let launchReturnUrl = urlParams.get('launch_presentation_return_url');
let contentItemReturnUrl = urlParams.get('content_item_return_url');
let ltiData = urlParams.get('lti_data');
let currentPlacementMapping = null;

async function checkActivePlacement() {
    if (!activeResourceLinkId) return;
    try {
        const res = await apiFetch(`/api/placements/${encodeURIComponent(activeResourceLinkId)}`);
        currentPlacementMapping = await res.json();
    } catch (err) {
        console.error('Failed to get active placement mapping', err);
    }
}

async function loadExams() {
    await checkActivePlacement();
    const res = await apiFetch('/api/exams');
    exams = await res.json();
    renderExams();
}

function renderExams() {
    let bannerHtml = '';
    if (contentItemReturnUrl) {
        bannerHtml = `
            <div style="background: rgba(59, 130, 246, 0.05); border: 1px solid rgba(59, 130, 246, 0.15); padding: 20px; border-radius: var(--radius); margin-bottom: 25px; display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <strong style="color: var(--accent); font-size: 15px;">📝 Canvas Content Selection Active</strong>
                    <div style="font-size:13px; color: var(--text-secondary); margin-top:4px;">
                        Select an exam below and click "Select and Embed" to add it to your Canvas Module.
                    </div>
                </div>
            </div>
        `;
    } else if (activeResourceLinkId) {
        const linkedExam = currentPlacementMapping ? exams.find(e => e.id == currentPlacementMapping.exam_id) : null;
        bannerHtml = `
            <div style="background: rgba(59, 130, 246, 0.05); border: 1px solid rgba(59, 130, 246, 0.15); padding: 20px; border-radius: var(--radius); margin-bottom: 25px; display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <strong style="color: var(--accent); font-size: 15px;">🔗 Canvas Placement Integration Active</strong>
                    <div style="font-size:13px; color: var(--text-secondary); margin-top:4px;">
                        ${linkedExam ? `This assignment/module link is bound to: <strong>${linkedExam.title}</strong>` 
                        : 'This assignment/module link is NOT linked to an exam yet. Select or create an exam below, then click "Link to this Canvas Placement" to activate it.'}
                    </div>
                </div>
            </div>
        `;
    }

    const content = document.getElementById('content');
    let html = `
        <div class="page-header">
            <div>
                <h1 class="page-title">Configured Exams</h1>
                <p class="page-subtitle">Select an exam below to enter its workspace, monitor live students, and view final reports.</p>
            </div>
            <button class="btn btn-primary" onclick="showCreateExamModal()">+ New Proctored Exam</button>
        </div>
        ${bannerHtml}
        <div class="session-grid">
    `;

    if (exams.length === 0) {
        html += `
            <div class="empty-state" style="grid-column: 1/-1;">
                <div class="empty-icon">🛡️</div>
                <div class="empty-text">No Exams configured yet</div>
                <div class="empty-hint">Click the button above to link your first Canvas quiz.</div>
            </div>
        `;
    } else {
        exams.forEach(ex => {
            html += `
                <div class="card session-card" style="position:relative; cursor:pointer;" onclick="loadExamDashboard(${ex.id})">
                    <div style="position:absolute; top: 20px; right: 20px; display: flex; gap: 8px;">
                        <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 11px;" onclick="event.stopPropagation(); showCreateExamModal(${ex.id})">Edit</button>
                        <button class="btn btn-danger" style="padding: 4px 10px; font-size: 11px;" onclick="event.stopPropagation(); deleteExam(${ex.id})">Delete</button>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom: 6px;">
                        <div class="session-date">${new Date(ex.created_at).toLocaleDateString()}</div>
                        <span class="badge ${ex.is_open ? 'badge-success' : 'badge-danger'}" style="font-size:9px; padding: 2px 8px;">
                            ${ex.is_open ? 'Open' : 'Closed'}
                        </span>
                    </div>
                    <div class="session-title" style="font-size:16px; font-weight:700; margin-bottom:10px; color:var(--text-primary);">${ex.title}</div>
                    <div style="margin-bottom: 12px; font-weight: 700; font-size: 12px; background: rgba(59, 130, 246, 0.1); color: var(--accent); padding: 6px 12px; border-radius: 6px; display: inline-block; font-family:monospace;">Exam Code: ${ex.exam_code}</div>
                    <div style="font-size: 12px; color: var(--text-secondary); line-height:1.6;">
                        <div>Max Attempts: ${ex.max_attempts || 1} | Boot Limit: ${ex.max_violations > 0 ? ex.max_violations + ' leaves' : 'Disabled'}</div>
                        <div style="margin-top:4px;">📷 Camera: ${ex.require_camera ? 'Yes' : 'No'} | 🎤 Mic: ${ex.require_mic ? 'Yes' : 'No'} | 💻 Screen: ${ex.require_screen ? 'Yes' : 'No'} | 🛡️ SEB: ${ex.require_seb ? 'Yes' : 'No'}</div>
                    </div>
                    ${contentItemReturnUrl ? `
                        <button class="btn btn-primary" style="margin-top: 15px; width: 100%; font-size:12px; padding: 10px;" onclick="event.stopPropagation(); embedExamSelection(${ex.id})">
                            Select and Embed Exam
                        </button>
                    ` : (activeResourceLinkId ? `
                        <button class="btn ${currentPlacementMapping && currentPlacementMapping.exam_id == ex.id ? 'btn-success' : 'btn-primary'}" style="margin-top: 15px; width: 100%; font-size:12px; padding: 10px;" onclick="event.stopPropagation(); linkPlacement(${ex.id})">
                            ${currentPlacementMapping && currentPlacementMapping.exam_id == ex.id ? '✓ Linked to placement' : 'Link to this Canvas Placement'}
                        </button>
                    ` : '')}
                </div>
            `;
        });
    }

    html += '</div>';
    content.innerHTML = html;
}

// THE NEW EXAM DASHBOARD (Master-Detail View)
function loadExamDashboard(examId) {
    const exam = exams.find(e => e.id == examId);
    if (!exam) return;
    
    currentLiveExamId = examId;
    liveStudents = {};
    socket.emit('join_teacher', examId);
    
    const content = document.getElementById('content');
    content.innerHTML = `
        <div class="page-header" style="display:flex; justify-content:space-between; align-items:center;">
            <div>
                <button class="btn btn-secondary" style="margin-bottom: 15px;" onclick="closeExamDashboard()">← Back to Exams</button>
                <div style="display:flex; align-items:center; gap: 15px;">
                    <h1 class="page-title">${exam.title} Workspace</h1>
                    <button class="btn" id="status-toggle-btn" 
                        style="padding: 6px 16px; font-size: 12px; border-radius: 20px; font-weight: 700; border: none; cursor: pointer; transition: var(--transition);
                        ${exam.is_open ? 'background:var(--success); color:white;' : 'background:var(--danger); color:white;'}"
                        onclick="toggleExamStatus(${exam.id})">
                        ${exam.is_open ? '🔓 Exam is OPEN' : '🔒 Exam is CLOSED'}
                    </button>
                    <button class="btn btn-secondary" style="padding: 6px 16px; font-size: 12px; border-radius: 20px; font-weight: 700;" onclick="showCreateExamModal(${exam.id})">⚙️ Edit Settings</button>
                </div>
                <p class="page-subtitle">Managing exam LTI placements with Access Code: <strong style="color:var(--accent); font-family:monospace;">${exam.exam_code}</strong></p>
            </div>
        </div>

        <!-- Metrics Dashboard Row -->
        <div class="metrics-row" style="margin-top:20px;">
            <div class="card stat-card info">
                <div class="stat-value" id="stat-total-attempts">--</div>
                <div class="stat-label">Total Attempts</div>
            </div>
            <div class="card stat-card success">
                <div class="stat-value" id="stat-active-sessions">0</div>
                <div class="stat-label">Active Students</div>
            </div>
            <div class="card stat-card danger">
                <div class="stat-value" id="stat-flagged-violations">0</div>
                <div class="stat-label">Flagged Warnings</div>
            </div>
            <div class="card stat-card warning">
                <div class="stat-value" id="stat-integrity-rate">100%</div>
                <div class="stat-label">Integrity Rate</div>
            </div>
        </div>
        
        <div style="display: flex; flex-direction: column; gap: 30px; margin-top: 10px;">
            <!-- Live Monitoring Block -->
            <div class="card" style="padding: 24px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 12px;">
                    <h2 style="font-size: 18px; font-weight: 700; margin: 0;">Live Monitoring Feed</h2>
                    <div style="display:flex; align-items:center; gap:12px;">
                        <button class="btn btn-warning-action btn-sm" onclick="sendBroadcastAnnouncement(${exam.id})">
                            📢 Broadcast Alert
                        </button>
                        <span style="font-size:12px; color:var(--text-secondary);">Click webcam to expand.</span>
                    </div>
                </div>
                <div id="live-grid" class="session-grid"></div>
            </div>
            
            <!-- Reports Block -->
            <div class="card" style="padding: 24px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 12px;">
                    <div style="display:flex; flex-direction:column; gap:4px;">
                        <h2 style="font-size: 18px; font-weight: 700; margin: 0;">Post-Exam Reports & Video Vault</h2>
                        <div id="submissions-ratio-badge" style="font-size: 13px; font-weight: 700; color: var(--warning); margin-top: 2px;">Submissions: loading...</div>
                    </div>
                    <div style="display:flex; gap: 10px;">
                        <button class="btn btn-primary" style="font-size:12px; padding: 8px 16px;" onclick="window.open('/api/exams/drive-folder', '_blank')">📁 Open Drive Vault</button>
                        <button class="btn btn-secondary" style="font-size:12px; padding: 8px 16px;" onclick="fetchReportData(${exam.id})">Refresh Reports</button>
                    </div>
                </div>
                
                <!-- Reports Search & Filters -->
                <div class="filter-search-container" style="margin-bottom: 20px; display: flex; gap: 12px;">
                    <input type="text" id="report-search-input" class="filter-input" placeholder="Search student by name..." />
                    <select id="report-risk-select" class="filter-select">
                        <option value="all">All Integrity Statuses</option>
                        <option value="low">🟢 Low Risk (Clean)</option>
                        <option value="moderate">🟡 Moderate Risk</option>
                        <option value="high">🔴 High Risk</option>
                    </select>
                </div>
                
                <div id="report-content"><div class="spinner"></div></div>
            </div>
        </div>
    `;
    
    updateLiveGrid();
    fetchReportData(examId);
}

function closeExamDashboard() {
    currentLiveExamId = null;
    loadExams();
}

// LIVE VIEW LOGIC
function updateLiveGrid() {
    const grid = document.getElementById('live-grid');
    if(!grid) return;
    grid.innerHTML = '';

    Object.keys(liveStudents).forEach(sessionId => {
        const s = liveStudents[sessionId];
        const statusColor = s.status === 'online' ? 'var(--success)' : 'var(--text-muted)';
        
        let content = '';
        if(s.screenshot) {
            content = `<img src="${s.screenshot}" style="width:100%; height:140px; object-fit:cover; border-radius: var(--radius-sm); cursor: pointer;" onclick="openFullscreenImg('${s.screenshot}', ${sessionId})" />`;
        } else {
            content = `<div style="width:100%; height:140px; background:rgba(0,0,0,0.3); border-radius: var(--radius-sm); display:flex; align-items:center; justify-content:center; color:var(--text-muted); border:1px dashed var(--border);">No Signal</div>`;
        }

        const warningBtn = s.status === 'online' ? `
            <button class="btn btn-warning-action btn-xs" style="margin-top:10px; width:100%; justify-content:center;" onclick="sendStudentWarning(${sessionId}, '${s.name || 'Student'}')">
                💬 Send Alert
            </button>
        ` : '';

        const hasFlags = s.hasFlags || false;
        const ringClass = s.status === 'online' ? (hasFlags ? 'live-ring-flagged' : 'live-ring-online') : 'live-ring-offline';

        grid.innerHTML += `
            <div class="card ${ringClass}" style="padding: 16px; background: rgba(30, 41, 59, 0.2);">
                <div style="display:flex; justify-content:space-between; margin-bottom:10px; align-items:center;">
                    <strong style="font-size: 14px; font-weight:600;">${s.name || 'Testing...'}</strong>
                    <span style="width: 8px; height: 8px; background: ${statusColor}; border-radius: 50%; display:inline-block; box-shadow: 0 0 6px ${statusColor};"></span>
                </div>
                ${content}
                ${warningBtn}
            </div>
        `;
    });

    if(Object.keys(liveStudents).length === 0) {
        grid.innerHTML = '<div style="color: var(--text-muted); font-size: 14px; grid-column:1/-1; padding:20px 0; text-align:center;">Live queue is currently empty. Waiting for students to authenticate...</div>';
    }

    // Refresh active count in metrics
    const activeVal = Object.keys(liveStudents).filter(id => liveStudents[id].status === 'online').length;
    const activeMetric = document.getElementById('stat-active-sessions');
    if (activeMetric) activeMetric.innerText = activeVal;
}

function sendStudentWarning(sessionId, studentName) {
    const warningText = prompt(`Send real-time warning alert to ${studentName}:`, "Please keep your eyes on the screen and remain in fullscreen mode.");
    if (warningText === null) return;
    const msg = warningText.trim();
    if (!msg) return;

    socket.emit('instructor_warning', {
        exam_session_id: sessionId,
        message: msg
    });
    showToast(`Warning sent to ${studentName}`, 'success');
}

function openFullscreenImg(src, sessionId) {
    currentFullscreenSessionId = sessionId;
    document.getElementById('fullscreen-image').src = src;
    document.getElementById('image-overlay').classList.add('active');
}

function closeImage() {
    currentFullscreenSessionId = null;
    document.getElementById('image-overlay').classList.remove('active');
}

// BROADCAST ANNOUNCEMENT
function sendBroadcastAnnouncement(examId) {
    const msgText = prompt("Enter an announcement or warning to broadcast to ALL online students currently taking this exam:", "Please remain focused. Ensure your webcam is clear and you do not leave the browser tab.");
    if (msgText === null) return;
    const msg = msgText.trim();
    if (!msg) return;

    socket.emit('instructor_broadcast', {
        exam_id: examId,
        message: msg
    });
    showToast("Broadcast message sent to all active students.", "success");
}

function getRiskInfo(session) {
    const logs = Array.isArray(session.logs) ? session.logs : [];
    const focusWarnings = logs.filter(l => ['tab_blur', 'window_blur', 'fullscreen_exit'].includes(l.event_type)).length;
    const aiWarnings = logs.filter(l => l.event_type.startsWith('AI_')).length;
    const totalWarnings = focusWarnings + aiWarnings;

    let category = 'low';
    let html = '<span class="badge badge-success">🟢 Low Risk</span>';

    if (totalWarnings > 2 || aiWarnings > 0) {
        category = 'high';
        html = `<span class="badge badge-danger" style="box-shadow: 0 0 8px rgba(239, 68, 68, 0.2);">🔴 High Risk (${totalWarnings} flags)</span>`;
    } else if (totalWarnings > 0) {
        category = 'moderate';
        html = `<span class="badge badge-warning">🟡 Mod Risk (${totalWarnings} flags)</span>`;
    }

    return { category, html, totalWarnings, focusWarnings, aiWarnings };
}

function filterReports(examId) {
    const searchInput = document.getElementById('report-search-input');
    const riskSelect = document.getElementById('report-risk-select');
    const tableBody = document.getElementById('report-table-body');
    if (!tableBody) return;

    const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
    const riskFilter = riskSelect ? riskSelect.value : 'all';

    let filtered = currentSessionsList;

    // Filter by name
    if (query) {
        filtered = filtered.filter(s => {
            const name = (s.student_name || s.student_canvas_id || '').toLowerCase();
            return name.includes(query);
        });
    }

    // Filter by risk
    if (riskFilter !== 'all') {
        filtered = filtered.filter(s => {
            const riskInfo = getRiskInfo(s);
            return riskInfo.category === riskFilter;
        });
    }

    let tbodyHtml = '';
    filtered.forEach(s => {
        const riskInfo = getRiskInfo(s);
        tbodyHtml += `
            <tr>
                <td style="font-weight: 700;">
                    ${s.student_name || s.student_canvas_id} 
                    <span style="font-size: 11px; color:var(--text-secondary); font-weight:400;">(Attempt ${s.attempt_number || 1})</span>
                </td>
                <td><span class="badge ${s.status === 'completed' ? 'badge-success' : 'badge-warning'}">${s.status}</span></td>
                <td>${new Date(s.started_at).toLocaleString()}</td>
                <td>${riskInfo.html}</td>
                <td>
                    <button onclick="viewStudentReport(${s.id}, ${examId})" class="btn btn-secondary btn-sm">View Report</button>
                </td>
            </tr>
        `;
    });

    if (filtered.length === 0) {
        tbodyHtml = '<tr><td colspan="5" style="text-align:center; padding: 30px; color:var(--text-muted);">No student reports match your filters.</td></tr>';
    }

    tableBody.innerHTML = tbodyHtml;
}

// REPORTS LOGIC
async function fetchReportData(examId) {
    if(!examId) return;
    const tableContainer = document.getElementById('report-content');
    if(!tableContainer) return;

    try {
        const res = await apiFetch(`/api/exams/${examId}/reports`);
        const data = await res.json();
        
        if (data.error) {
            tableContainer.innerHTML = `<div style="padding: 20px; color: var(--danger); text-align:center;">Error loading reports: ${data.error}</div>`;
            return;
        }

        const sessions = data.sessions || [];
        const enrolledCount = data.enrolled_count || 0;
        
        currentSessionsList = sessions;
        
        // Compute and update stats metrics cards
        const totalAttemptsVal = sessions.length;
        let totalViolationsVal = 0;
        let flaggedAttemptsCount = 0;
        
        sessions.forEach(s => {
            const logs = s.logs || [];
            const studentFlags = logs.filter(l => ['tab_blur', 'window_blur', 'fullscreen_exit', 'error', 'fail'].includes(l.event_type)).length;
            totalViolationsVal += studentFlags;
            if (studentFlags > 0) flaggedAttemptsCount++;
        });

        const integrityRateVal = totalAttemptsVal > 0 ? Math.round(((totalAttemptsVal - flaggedAttemptsCount) / totalAttemptsVal) * 100) : 100;

        document.getElementById('stat-total-attempts').innerText = totalAttemptsVal;
        document.getElementById('stat-flagged-violations').innerText = totalViolationsVal;
        document.getElementById('stat-integrity-rate').innerText = `${integrityRateVal}%`;

        const submittedCount = sessions.filter(s => s.status === 'completed').length;
        const ratioBadge = document.getElementById('submissions-ratio-badge');
        if (ratioBadge) {
            ratioBadge.innerText = `Submissions: ${submittedCount} of ${enrolledCount || submittedCount} enrolled completed`;
        }

        tableContainer.innerHTML = `
            <div class="table-wrapper">
            <table>
                <thead>
                    <tr>
                        <th>Student Name</th>
                        <th>Status</th>
                        <th>Started At</th>
                        <th>Integrity Flags</th>
                        <th>Proctoring Report</th>
                    </tr>
                </thead>
                <tbody id="report-table-body">
                    <!-- Loaded dynamically -->
                </tbody>
            </table>
            </div>
        `;

        // Bind filter event listeners if they exist
        const searchInput = document.getElementById('report-search-input');
        const riskSelect = document.getElementById('report-risk-select');
        
        if (searchInput && !searchInput.dataset.bound) {
            searchInput.dataset.bound = "true";
            searchInput.addEventListener('input', () => filterReports(examId));
        }
        if (riskSelect && !riskSelect.dataset.bound) {
            riskSelect.dataset.bound = "true";
            riskSelect.addEventListener('change', () => filterReports(examId));
        }

        // Trigger initial table rendering
        filterReports(examId);

    } catch (err) {
        console.error("Report fetch failed", err);
        tableContainer.innerHTML = `<div style="padding: 20px; color: var(--danger); text-align:center;">Failed to load reports. Check server logs.</div>`;
    }
}

let activeLogFilterSeverity = 'all';
let activeLogFilterSearch = '';

function viewStudentReport(sessionId, examId) {
    const exam = exams.find(e => e.id == examId);
    const session = currentSessionsList.find(s => s.id == sessionId);
    if (!session) return;
    
    // Setup filter states
    activeLogFilterSeverity = 'all';
    activeLogFilterSearch = '';

    const renderLogsTimeline = () => {
        const logs = Array.isArray(session.logs) ? session.logs : [];
        const container = document.getElementById('modal-timeline-list');
        if (!container) return;

        let filteredLogs = logs;

        // Filter by search query
        if (activeLogFilterSearch) {
            const query = activeLogFilterSearch.toLowerCase();
            filteredLogs = filteredLogs.filter(l => 
                l.event_message.toLowerCase().includes(query) || 
                l.event_type.toLowerCase().includes(query)
            );
        }

        // Filter by severity
        if (activeLogFilterSeverity === 'flag') {
            filteredLogs = filteredLogs.filter(l => 
                ['tab_blur', 'window_blur', 'fullscreen_exit', 'error', 'fail'].includes(l.event_type) || 
                l.event_type.startsWith('AI_')
            );
        } else if (activeLogFilterSeverity === 'info') {
            filteredLogs = filteredLogs.filter(l => 
                !['tab_blur', 'window_blur', 'fullscreen_exit', 'error', 'fail'].includes(l.event_type) && 
                !l.event_type.startsWith('AI_')
            );
        }

        let logsHtml = '';
        filteredLogs.forEach(l => {
            const isAI = l.event_type.startsWith('AI_');
            const isDanger = ['tab_blur', 'window_blur', 'fullscreen_exit', 'booted', 'error', 'fail'].includes(l.event_type) || isAI;
            const badgeColor = isAI ? 'badge-warning' : (isDanger ? 'badge-danger' : 'badge-success');
            const badgeLabel = isAI ? '🤖 AI DETECTION' : l.event_type.toUpperCase();
            
            logsHtml += `
                <li style="margin-bottom: 12px; border-bottom: 1px solid var(--border); padding-bottom: 10px; display: flex; flex-direction: column; gap: 4px;">
                    <div>
                        <span class="badge ${badgeColor}" style="font-size:9px; padding: 2px 6px;">${badgeLabel}</span>
                        <span style="color:var(--text-muted); font-size:11px; margin-left: 8px;">${new Date(l.event_timestamp).toLocaleTimeString()}</span>
                    </div>
                    <span style="font-size:13px; color:var(--text-primary); line-height: 1.4; margin-top: 4px;">${l.event_message}</span>
                </li>
            `;
        });

        if (filteredLogs.length === 0) {
            logsHtml = "<li style='color:var(--text-muted); text-align:center; padding: 20px; font-size:13px;'>No matching log events found.</li>";
        }
        container.innerHTML = logsHtml;
    };

    const showVideo = session.status === 'completed' && !session.video_archived;
    let videoElementHtml = '';
    if (showVideo) {
        if (session.drive_file_id) {
            videoElementHtml = `<iframe src="https://drive.google.com/file/d/${session.drive_file_id}/preview" style="width: 100%; height: 100%; border: none;" allow="autoplay"></iframe>`;
        } else {
            videoElementHtml = `<video src="/api/session/video-playback/${session.id}" controls style="width: 100%; height: 100%; object-fit: contain;"></video>`;
        }
    }
    const videoHtml = showVideo ? `
        <div style="margin-bottom: 15px;">
            <h4 style="margin: 0 0 10px 0; font-size:14px; font-weight:700; color:var(--text-primary);">Webcam Proctoring Footage (Google Drive Player)</h4>
            <div style="background: black; border-radius: var(--radius); overflow: hidden; aspect-ratio: 16/9; border: 1px solid var(--border);">
                ${videoElementHtml}
            </div>
        </div>
    ` : `
        <div style="margin-bottom: 15px; background: rgba(255, 255, 255, 0.02); border: 1px dashed var(--border); border-radius: var(--radius); padding: 30px; text-align: center; color: var(--text-secondary);">
            <span style="font-size: 32px; display:block; margin-bottom: 8px;">🎥</span>
            ${session.video_archived ? '<strong>Video Footage Archived Off-Site</strong><br><span style="font-size:12px; color:var(--text-muted);">This recording was hard purged to reclaim storage space.</span>' : '<strong>Video Recording Finalizing...</strong><br><span style="font-size:12px; color:var(--text-muted);">The footage is still being assembled and uploaded in the background.</span>'}
        </div>
    `;

    const hasSnapshots = session.drive_snapshots_id;
    let snapshotsPanelHtml = '';
    if (hasSnapshots) {
        snapshotsPanelHtml = `
            <div style="background: rgba(59, 130, 246, 0.04); border: 1px solid rgba(59, 130, 246, 0.15); border-radius: var(--radius); padding: 16px; display: flex; justify-content: space-between; align-items: center; margin-top: 15px;">
                <div>
                    <h5 style="margin:0; font-size:13px; font-weight:700; color:var(--text-primary);">DOM Quiz Screenshots</h5>
                    <p style="margin: 4px 0 0 0; font-size:11px; color:var(--text-secondary);">ZIP folder containing student quiz screenshots.</p>
                </div>
                <a class="btn btn-success btn-sm" href="https://drive.google.com/uc?export=download&id=${session.drive_snapshots_id}" target="_blank">
                    📥 Download ZIP
                </a>
            </div>
        `;
    }

    const modalContentHtml = `
        <div class="modal-header">
            <div>
                <h2 class="modal-title" style="font-family:'Lato','Inter',sans-serif; font-size:20px;">Attempt Details: ${session.student_name || session.student_canvas_id}</h2>
                <p style="margin:4px 0 0 0; font-size:12px; color:var(--text-secondary); font-family:monospace;">Exam: ${exam.title} | Attempt ${session.attempt_number || 1} | Started: ${new Date(session.started_at).toLocaleString()}</p>
            </div>
            <button class="modal-close" onclick="closeModal()">×</button>
        </div>
        <div class="modal-body">
            <div class="modal-split-layout">
                <!-- Left Pane: Media & Downloads -->
                <div>
                    ${videoHtml}
                    ${snapshotsPanelHtml}
                </div>
                
                <!-- Right Pane: Timeline & Filters -->
                <div style="display:flex; flex-direction:column; height: 100%;">
                    <h4 style="margin: 0 0 10px 0; font-size:14px; font-weight:700; color:var(--text-primary);">Security Integrity Log</h4>
                    
                    <!-- Search & Filter Controls -->
                    <div class="filter-search-container">
                        <input type="text" id="log-search-input" class="filter-input" placeholder="Search event message..." />
                        <select id="log-severity-select" class="filter-select">
                            <option value="all">All Events</option>
                            <option value="flag">Warnings / Flags</option>
                            <option value="info">Info Logs</option>
                        </select>
                    </div>
                    
                    <ul id="modal-timeline-list" style="padding-left: 0; list-style-type: none; margin: 0; max-height: 290px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 16px; background: var(--bg-primary);">
                        <!-- Rendered dynamically -->
                    </ul>
                </div>
            </div>
        </div>
        <div style="margin-top: 24px; display:flex; justify-content:space-between; align-items:center; border-top:1px solid var(--border); padding-top: 15px;">
            <div style="display:flex; gap: 8px;">
                <button class="btn btn-secondary btn-sm" onclick="grantExtraAttempt(${exam.id}, '${session.student_canvas_id}')">+1 Override Pass</button>
                <button class="btn btn-danger btn-sm" onclick="deleteStudentAttempt(${session.id}, ${exam.id})">Delete Session</button>
            </div>
            <button class="btn btn-primary btn-sm" onclick="closeModal()">Done</button>
        </div>
    `;
    
    const modalOverlay = document.getElementById('modal-overlay');
    const modalContainer = document.getElementById('modal-content');
    modalContainer.style.maxWidth = '900px';
    modalContainer.style.width = '95%';
    modalContainer.innerHTML = modalContentHtml;
    modalOverlay.classList.add('active');

    // Initial log timeline draw
    renderLogsTimeline();

    // Bind log filter inputs
    const searchInput = document.getElementById('log-search-input');
    const severitySelect = document.getElementById('log-severity-select');

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            activeLogFilterSearch = e.target.value;
            renderLogsTimeline();
        });
    }

    if (severitySelect) {
        severitySelect.addEventListener('change', (e) => {
            activeLogFilterSeverity = e.target.value;
            renderLogsTimeline();
        });
    }
}

async function deleteStudentAttempt(sessionId, examId) {
    if (!confirm("Are you sure you want to permanently delete this student attempt and all associated security logs? This cannot be undone.")) return;
    try {
        const res = await apiFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
        if (res.ok) {
            closeModal();
            showToast("Student attempt deleted successfully.", "success");
            fetchReportData(examId);
        } else {
            showToast("Failed to delete attempt", "warning");
        }
    } catch (err) {
        console.error(err);
        showToast("Error deleting attempt", "warning");
    }
}

// EXAM GENERATION & DELETION MODALS
function showCreateExamModal(examId = null) {
    const exam = examId ? exams.find(e => e.id == examId) : null;
    const defaultCode = exam ? exam.exam_code : Math.random().toString(36).substring(2, 8).toUpperCase();
    const html = `
        <div class="modal-header">
            <h2 class="modal-title">${exam ? 'Edit Exam Settings' : 'Link LMS Quiz'}</h2>
            <button class="modal-close" onclick="closeModal()">×</button>
        </div>
        <div class="form-group">
            <label class="form-label">Exam Title</label>
            <input type="text" id="exam-title" class="form-input" placeholder="e.g. Midterm Physics" value="${exam ? exam.title : ''}">
        </div>
        <div class="form-group" style="display: flex; gap: 10px;">
            <div style="flex:1;">
                <label class="form-label">Access Code</label>
                <input type="text" id="exam-code" class="form-input" value="${defaultCode}">
            </div>
            <div style="flex:1;">
                <label class="form-label">Max Attempts</label>
                <input type="number" id="max-attempts" class="form-input" value="${exam ? exam.max_attempts : 1}" min="1">
            </div>
            <div style="flex:1;">
                <label class="form-label">Boot Limit (Tab Leaves)</label>
                <input type="number" id="max-violations" class="form-input" value="${exam ? exam.max_violations : 0}" min="0">
                <div style="font-size:9px; color:var(--text-muted); margin-top:2px;">0 = Unlimited (no boot)</div>
            </div>
        </div>
        <div class="form-group">
            <label class="form-label">LMS Quiz URL</label>
            <input type="text" id="exam-url" class="form-input" placeholder="https://canvas.instructure.com/courses/1/quizzes/1" value="${exam ? exam.canvas_quiz_url : ''}">
            <div class="form-hint">Paste the URL of the LMS Quiz. Do NOT share this URL directly with students.</div>
        </div>
        <div class="form-group">
            <label class="form-label">Canvas Quiz Password / Access Code (Optional)</label>
            <input type="text" id="quiz-password" class="form-input" placeholder="e.g. SECURE-WWI-QUIZ" value="${exam && exam.canvas_quiz_password ? exam.canvas_quiz_password : ''}">
            <div class="form-hint">If your Canvas quiz requires a password/access code to start, enter it here. It will be securely shown to verified students when the exam begins.</div>
        </div>
        <div style="margin-top: 20px;">
            <label class="form-check" style="margin-bottom: 8px;">
                <input type="checkbox" id="chk-camera" ${!exam || exam.require_camera ? 'checked' : ''}> Require Web Camera
            </label>
            <label class="form-check" style="margin-bottom: 8px;">
                <input type="checkbox" id="chk-mic" ${!exam || exam.require_mic ? 'checked' : ''}> Require Microphone
            </label>
            <label class="form-check" style="margin-bottom: 8px;">
                <input type="checkbox" id="chk-screen" ${!exam || exam.require_screen ? 'checked' : ''}> Require Screen Sharing (Entire Screen)
            </label>
            <label class="form-check" style="margin-bottom: 8px;">
                <input type="checkbox" id="chk-rc" ${!exam || exam.disable_right_click ? 'checked' : ''}> Disable Right Click / Tab Switches
            </label>
            <label class="form-check" style="margin-bottom: 8px;">
                <input type="checkbox" id="chk-fs" ${!exam || exam.require_fullscreen ? 'checked' : ''}> Enforce Fullscreen Mode
            </label>
            <label class="form-check">
                <input type="checkbox" id="chk-seb" ${exam && exam.require_seb ? 'checked' : ''}> Require Safe Exam Browser
            </label>
        </div>
        <div style="margin-top: 24px; text-align: right;">
            <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="saveExam(${examId})">${exam ? 'Save Changes' : 'Create'}</button>
        </div>
    `;
    
    document.getElementById('modal-content').innerHTML = html;
    document.getElementById('modal-overlay').classList.add('active');
}

async function saveExam(examId = null) {
    const payload = {
        title: document.getElementById('exam-title').value,
        canvas_quiz_url: document.getElementById('exam-url').value,
        exam_code: document.getElementById('exam-code').value,
        max_attempts: parseInt(document.getElementById('max-attempts').value) || 1,
        max_violations: parseInt(document.getElementById('max-violations').value) || 0,
        canvas_quiz_password: document.getElementById('quiz-password').value.trim(),
        require_camera: document.getElementById('chk-camera').checked,
        require_mic: document.getElementById('chk-mic').checked,
        require_screen: document.getElementById('chk-screen').checked,
        disable_right_click: document.getElementById('chk-rc').checked,
        require_fullscreen: document.getElementById('chk-fs').checked,
        require_seb: document.getElementById('chk-seb').checked
    };

    if(!payload.title || !payload.canvas_quiz_url) return alert('Fill all fields');

    try {
        const url = examId ? `/api/exams/${examId}` : '/api/exams';
        const method = examId ? 'PATCH' : 'POST';
        
        const res = await apiFetch(url, {
            method: method, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if(res.ok) {
            closeModal();
            loadExams();
            showToast(examId ? 'Settings updated!' : 'Exam configured securely!', 'success');
            
            // If we are in the dashboard, we might want to stay there
            if (currentLiveExamId && examId == currentLiveExamId) {
                // The exams array is reloaded by loadExams, but we need to re-render the current view
                setTimeout(() => loadExamDashboard(currentLiveExamId), 500); 
            }
        }
    } catch(err) {
        console.error(err);
    }
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('active');
}

async function toggleExamStatus(id) {
    const exam = exams.find(e => e.id == id);
    if (!exam) return;
    
    const newStatus = !exam.is_open;
    try {
        const res = await apiFetch(`/api/exams/${id}/status`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_open: newStatus })
        });
        
        if (res.ok) {
            const updatedExam = await res.json();
            // Update local state
            exam.is_open = updatedExam.is_open;
            
            // If we are currently in the dashboard for this exam, re-render it
            if (currentLiveExamId == id) {
                loadExamDashboard(id);
            } else {
                renderExams();
            }
            
            showToast(`Exam is now ${updatedExam.is_open ? 'OPEN' : 'CLOSED'}`, 'success');
        }
    } catch (err) {
        console.error(err);
        showToast('Failed to toggle status', 'warning');
    }
}

async function deleteExam(id) {
    if(confirm('WARNING: Are you sure you want to completely delete this exam and all student video recordings? This is permanent.')) {
        try {
            await apiFetch('/api/exams/' + id, {method: 'DELETE'});
            loadExams();
            showToast('Exam completely deleted.', 'success');
        } catch(e) {
            console.error(e);
        }
    }
}

async function grantExtraAttempt(examId, studentCanvasId) {
    if(!confirm("Are you sure you want to grant this specific student an additional attempt?")) return;
    try {
        await apiFetch('/api/exams/' + examId + '/overrides', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ student_canvas_id: studentCanvasId })
        });
        showToast('Attempt Override Granted Successfully!', 'success');
    } catch(err) {
        console.error(err);
        showToast('Error granting attempt', 'warning');
    }
}

function showToast(msg, type='info') {
    const el = document.createElement('div');
    el.style.background = type === 'success' ? 'var(--success)' : (type === 'warning' ? 'var(--warning)' : 'var(--text-primary)');
    el.style.color = 'white';
    el.style.padding = '12px 20px';
    el.style.borderRadius = 'var(--radius)';
    el.style.boxShadow = 'var(--shadow)';
    el.style.fontSize = '14px';
    el.innerText = msg;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

async function linkPlacement(examId) {
    if (!activeResourceLinkId) return;
    try {
        const res = await apiFetch('/api/placements', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resource_link_id: activeResourceLinkId, exam_id: examId })
        });
        if (res.ok) {
            showToast('Successfully linked Canvas placement to this exam!', 'success');
            const mapping = await res.json();
            currentPlacementMapping = mapping;
            
            if (contentItemReturnUrl) {
                const exam = exams.find(e => e.id == examId);
                const examTitle = exam ? exam.title : 'Proctor Gateway Assignment';
                const launchUrl = window.location.origin + '/lti/launch';
                window.location.href = `/api/placements/lti-return?content_item_return_url=${encodeURIComponent(contentItemReturnUrl)}&exam_title=${encodeURIComponent(examTitle)}&launch_url=${encodeURIComponent(launchUrl)}`;
            } else if (launchReturnUrl) {
                const exam = exams.find(e => e.id == examId);
                const examTitle = exam ? exam.title : 'Proctor Gateway Assignment';
                const launchUrl = window.location.origin + '/lti/launch';
                const returnRedirectUrl = `${launchReturnUrl}?return_type=lti_launch_url&url=${encodeURIComponent(launchUrl)}&title=${encodeURIComponent(examTitle)}&text=${encodeURIComponent(examTitle)}`;
                
                // Redirect top/parent frame to finalize and close selection modal
                if (window.parent && window.parent !== window) {
                    window.parent.location.href = returnRedirectUrl;
                } else {
                    window.location.href = returnRedirectUrl;
                }
            } else {
                loadExams();
            }
        } else {
            showToast('Failed to save link mapping', 'warning');
        }
    } catch (err) {
        console.error(err);
        showToast('Connection error', 'warning');
    }
}

function embedExamSelection(examId) {
    if (!contentItemReturnUrl) return;
    const exam = exams.find(e => e.id == examId);
    const examTitle = exam ? exam.title : 'Proctor Gateway Assignment';
    // Embed the exam_id in the launch URL returned to Canvas
    const launchUrl = `${window.location.origin}/lti/launch?exam_id=${examId}`;
    let targetUrl = `/api/placements/lti-return?content_item_return_url=${encodeURIComponent(contentItemReturnUrl)}&exam_title=${encodeURIComponent(examTitle)}&launch_url=${encodeURIComponent(launchUrl)}`;
    if (ltiData) {
        targetUrl += `&lti_data=${encodeURIComponent(ltiData)}`;
    }
    window.location.href = targetUrl;
}
