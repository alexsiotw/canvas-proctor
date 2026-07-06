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
        
        const isFlag = ['tab_blur', 'window_blur', 'fullscreen_exit', 'audio_violation', 'mic_muted', 'error', 'fail'].includes(data.event_type) || data.event_type.startsWith('AI_');
        if (isFlag) {
            s.flagCount++;
            s.hasFlags = true;
            s.lastFlagType = data.event_type;
            s.lastFlagMessage = data.event_message;
            
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

// Auto-resize LTI iframe to avoid double scrollbars and locked scrolling in Canvas
function initLtiFrameResize() {
    const sendResize = () => {
        if (window.parent && window.parent !== window) {
            const height = document.body.scrollHeight || document.documentElement.scrollHeight;
            window.parent.postMessage(JSON.stringify({
                subject: "lti.frameResize",
                height: height
            }), "*");
        }
    };
    
    window.addEventListener('load', sendResize);
    window.addEventListener('resize', sendResize);
    
    // Also send resize whenever DOM changes
    const observer = new MutationObserver(sendResize);
    observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true
    });
    
    // Initial calls
    setTimeout(sendResize, 100);
    setTimeout(sendResize, 500);
    setTimeout(sendResize, 1000);
}

document.addEventListener('DOMContentLoaded', () => {
    initLtiFrameResize();
    checkDatabaseCapacity();
    document.getElementById('passcode-overlay').style.display = 'none';
    document.getElementById('app').style.display = '';
    loadExams();
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

let canvasQuizzes = [];

async function loadExams() {
    await checkActivePlacement();
    
    // Fetch exams
    try {
        const res = await apiFetch('/api/exams');
        exams = await res.json();
    } catch (err) {
        console.error("Failed to load exams", err);
    }
    
    // Fetch Canvas quizzes
    try {
        const res = await apiFetch('/api/canvas-quizzes');
        if (res.ok) {
            canvasQuizzes = await res.json();
            if (!Array.isArray(canvasQuizzes)) canvasQuizzes = [];
        } else {
            console.warn("Canvas quizzes fetch failed, falling back to mock quizzes");
            canvasQuizzes = [];
        }
    } catch (err) {
        console.error("Failed to fetch Canvas quizzes, falling back to mock quizzes", err);
        canvasQuizzes = [];
    }
    
    // Safety check: if exams is not an array, it means authentication failed
    if (!Array.isArray(exams)) {
        const content = document.getElementById('content');
        if (content) {
            content.innerHTML = `
                <div style="padding: 40px; text-align: center; max-width: 600px; margin: 0 auto; margin-top: 50px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg);">
                    <div style="font-size: 40px; margin-bottom: 20px;">⚠️</div>
                    <h2 style="font-family: 'Outfit', sans-serif; color: var(--text-primary); margin-bottom: 15px;">Session Authentication Required</h2>
                    <p style="color: var(--text-secondary); line-height: 1.6; margin-bottom: 20px;">Your instructor session could not be verified.</p>
                    <p style="color: var(--text-secondary); line-height: 1.6;">Please launch ProctorGuard via the Canvas Course Navigation menu or click the dashboard links from within Canvas to establish a secure session.</p>
                </div>
            `;
        }
        return;
    }

    renderExams();

    // Auto-load exam dashboard if currentPlacementMapping specifies an exam_id
    if (currentPlacementMapping && currentPlacementMapping.exam_id) {
        const matchingExam = exams.find(ex => ex.id === currentPlacementMapping.exam_id);
        if (matchingExam) {
            loadExamDashboard(matchingExam.id);
            return;
        }
    }

    // Auto-load exam dashboard if quiz_id is in URL
    const targetQuizId = urlParams.get('quiz_id');
    if (targetQuizId && exams.length > 0) {
        const linkedExam = exams.find(ex => ex.canvas_quiz_url && ex.canvas_quiz_url.includes('/quizzes/' + targetQuizId));
        if (linkedExam) {
            loadExamDashboard(linkedExam.id);
            if (urlParams.get('view') === 'live') {
                setTimeout(() => {
                    const grid = document.getElementById('live-grid');
                    if (grid) grid.scrollIntoView({ behavior: 'smooth' });
                }, 500);
            } else {
                setTimeout(() => {
                    const reports = document.getElementById('report-content');
                    if (reports) reports.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }, 500);
            }
        }
    }
}

function getCourseQuizzes() {
    const courseId = activeResourceLinkId || urlParams.get('course_id') || 'demo_course';
    return [
        {
            id: 101,
            title: "Example of a New Quiz",
            type: "New Quiz",
            start_date: "Aug 9, 9:00 AM",
            end_date: "Aug 13, 8:59 AM",
            quiz_url: `https://canvas.instructure.com/courses/${courseId}/quizzes/101`
        },
        {
            id: 102,
            title: "Example of a Classic Quiz",
            type: "Classic Quiz",
            start_date: "Aug 20, 12:00 AM",
            end_date: "Aug 21, 11:59 PM",
            quiz_url: `https://canvas.instructure.com/courses/${courseId}/quizzes/102`
        },
        {
            id: 103,
            title: "Midterm Physics Examination",
            type: "Classic Quiz",
            start_date: "Sep 15, 10:00 AM",
            end_date: "Sep 15, 12:00 PM",
            quiz_url: `https://canvas.instructure.com/courses/${courseId}/quizzes/103`
        },
        {
            id: 104,
            title: "Final Term Assessment",
            type: "New Quiz",
            start_date: "Dec 10, 9:00 AM",
            end_date: "Dec 12, 5:00 PM",
            quiz_url: `https://canvas.instructure.com/courses/${courseId}/quizzes/104`
        }
    ];
}

function enableQuizProctoring(title, quizUrl) {
    showCreateExamModal();
    document.getElementById('exam-title').value = title;
    document.getElementById('exam-url').value = quizUrl;
}

function renderExams() {
    const content = document.getElementById('content');
    const quizzes = canvasQuizzes.length > 0 ? canvasQuizzes : getCourseQuizzes();
    
    let tbodyHtml = '';
    quizzes.forEach(q => {
        // Find if quiz is enabled in exams list
        const linkedExam = exams.find(ex => ex.canvas_quiz_url === q.quiz_url || ex.canvas_quiz_url.includes(`/quizzes/${q.id}`));
        
        let actionsHtml = '';
        let titleHtml = '';
        
        if (linkedExam) {
            // Enabled state (Dashboard, Settings, Disable buttons)
            titleHtml = `<a href="javascript:void(0)" onclick="loadExamDashboard(${linkedExam.id})" style="color: var(--accent); font-weight: 700; text-decoration:none; transition:var(--transition); font-size: 14px; font-family:'Outfit',sans-serif;">${q.title}</a>`;
            actionsHtml = `
                <div style="display:flex; gap:6px; justify-content:flex-end;">
                    <button class="btn btn-slate btn-sm" onclick="loadExamDashboard(${linkedExam.id})" style="font-weight:700;">Dashboard</button>
                    <button class="btn btn-slate btn-sm" onclick="showCreateExamModal(${linkedExam.id})" style="font-weight:700;">Settings</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteExam(${linkedExam.id})" style="font-weight:700;">Disable</button>
                </div>
            `;
        } else {
            // Disabled state (Enable button)
            titleHtml = `<span style="color: var(--text-primary); font-weight: 500; font-size: 14px; font-family:'Outfit',sans-serif;">${q.title}</span>`;
            actionsHtml = `
                <div style="display:flex; justify-content:flex-end; align-items:center; gap: 10px;">
                    <span style="color: #ea580c; font-size:16px;">➔</span>
                    <button class="btn btn-primary btn-sm" onclick="enableQuizProctoring('${q.title.replace(/'/g, "\\'")}', '${q.quiz_url}')" style="font-weight:700; padding: 6px 18px;">Enable</button>
                </div>
            `;
        }
        
        tbodyHtml += `
            <tr style="border-bottom: 1px solid var(--border); transition:var(--transition);">
                <td style="padding: 16px; vertical-align:middle;">${titleHtml}</td>
                <td style="padding: 16px; color: var(--text-secondary); vertical-align:middle; font-size:13px;">${q.type}</td>
                <td style="padding: 16px; color: var(--text-secondary); vertical-align:middle; font-size:13px; line-height: 1.5;">
                    Start: ${q.start_date}<br>
                    End: ${q.end_date}
                </td>
                <td style="padding: 16px; vertical-align:middle;">${actionsHtml}</td>
            </tr>
        `;
    });

    content.innerHTML = `
        <div class="page-header" style="margin-bottom: 30px;">
            <div>
                <h1 class="page-title" style="font-family:'Outfit', sans-serif; font-size:24px; font-weight:700;">Canvas Quizzes</h1>
                <p class="page-subtitle" style="font-family:'Plus Jakarta Sans', sans-serif;">Enable, configure, and monitor secure proctoring options for all quizzes in this course.</p>
            </div>
        </div>

        <div class="card" style="padding: 24px; background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-lg); box-shadow:var(--shadow);">
            <!-- Schoolyear-style pagination header bar -->
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 15px;">
                <div style="font-size:14px; font-weight:700; color:var(--text-secondary); font-family:'Outfit',sans-serif;">
                    Course Quizzes List
                </div>
                <div style="display:flex; align-items:center; gap:12px; font-size:13px; color:var(--text-secondary);">
                    <button class="btn btn-secondary btn-sm" disabled style="padding: 5px 12px; opacity:0.6;">Previous</button>
                    <span>Page 1 of 1</span>
                    <button class="btn btn-secondary btn-sm" disabled style="padding: 5px 12px; opacity:0.6;">Next</button>
                    <div style="display:flex; align-items:center; margin-left: 8px;">
                        <span>Items per page:</span>
                        <select class="filter-select" style="padding: 4px 8px; font-size:12px; margin-left: 5px; background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text-primary);">
                            <option>100</option>
                        </select>
                    </div>
                </div>
            </div>

            <!-- The Quizzes Table -->
            <div class="table-wrapper" style="border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden;">
                <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                        <tr style="border-bottom: 2px solid var(--border); background: rgba(0, 0, 0, 0.01);">
                            <th style="font-family:'Outfit',sans-serif; font-weight:700; color:var(--text-primary); text-transform:none; letter-spacing:0; font-size:14px; padding: 16px; text-align:left;">Quiz Name</th>
                            <th style="font-family:'Outfit',sans-serif; font-weight:700; color:var(--text-primary); text-transform:none; letter-spacing:0; font-size:14px; padding: 16px; text-align:left;">Type</th>
                            <th style="font-family:'Outfit',sans-serif; font-weight:700; color:var(--text-primary); text-transform:none; letter-spacing:0; font-size:14px; padding: 16px; text-align:left;">Dates</th>
                            <th style="font-family:'Outfit',sans-serif; font-weight:700; color:var(--text-primary); text-transform:none; letter-spacing:0; font-size:14px; padding: 16px; text-align:right;">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tbodyHtml}
                    </tbody>
                </table>
            </div>
        </div>
    `;
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
        <div class="page-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 15px;">
            <div>
                <button class="btn btn-secondary" style="margin-bottom: 12px;" onclick="closeExamDashboard()">← Back to Exams</button>
                <div style="display:flex; align-items:center; gap: 15px;">
                    <h1 class="page-title" style="font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">${exam.title} Workspace</h1>
                    <button class="btn" id="status-toggle-btn" 
                        style="padding: 6px 16px; font-size: 12px; border-radius: 20px; font-weight: 700; border: none; cursor: pointer; transition: var(--transition);
                        ${exam.is_open ? 'background:var(--success); color:white;' : 'background:var(--danger); color:white;'}"
                        onclick="toggleExamStatus(${exam.id})">
                        ${exam.is_open ? '🔓 Exam is OPEN' : '🔒 Exam is CLOSED'}
                    </button>
                </div>
                <p class="page-subtitle">Managing exam LTI placements with Access Code: <strong style="color:var(--accent); font-family:monospace;">${exam.exam_code}</strong></p>
            </div>
        </div>

        <!-- ProctorGuard Navigation Tabbar -->
        <div style="background: #ffffff; border: 1px solid var(--border); border-radius: var(--radius-lg); margin-bottom: 25px; padding: 0 16px;">
            <div style="display: flex; gap: 20px; align-items: center; height: 50px; font-size: 14px;">
                <div class="proctor-tab active" style="font-weight: 700; color: var(--accent); border-bottom: 3px solid var(--accent); height: 100%; display: flex; align-items: center; padding: 0 4px; cursor: pointer;">
                    📊 ProctorGuard Review Center
                </div>
                <div class="proctor-tab" onclick="showCreateExamModal(${exam.id})" style="font-weight: 500; color: var(--text-secondary); height: 100%; display: flex; align-items: center; padding: 0 4px; cursor: pointer;" onmouseenter="this.style.color='var(--text-primary)'" onmouseleave="this.style.color='var(--text-secondary)'">
                    ⚙️ ProctorGuard Settings
                </div>
                <div class="proctor-tab" style="font-weight: 500; color: var(--text-secondary); height: 100%; display: flex; align-items: center; padding: 0 4px; cursor: pointer;" onmouseenter="this.style.color='var(--text-primary)'" onmouseleave="this.style.color='var(--text-secondary)'">
                    📍 ProctorGuard Map
                </div>
                <div class="proctor-tab" style="font-weight: 500; color: var(--text-secondary); height: 100%; display: flex; align-items: center; padding: 0 4px; cursor: pointer;" onmouseenter="this.style.color='var(--text-primary)'" onmouseleave="this.style.color='var(--text-secondary)'">
                    🎛️ Display Options
                </div>
                <div class="proctor-tab" style="font-weight: 500; color: var(--text-secondary); height: 100%; display: flex; align-items: center; padding: 0 4px; cursor: pointer;" onmouseenter="this.style.color='var(--text-primary)'" onmouseleave="this.style.color='var(--text-secondary)'">
                    📤 Export Options
                </div>
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
function getShortFlagLabel(type) {
    if (type === 'audio_violation') return '🗣️ Speaking';
    if (type === 'mic_muted') return '🔇 Mic Muted';
    if (type === 'tab_blur' || type === 'window_blur') return '🔒 Focus Lost';
    if (type === 'fullscreen_exit') return '🖥️ Fullscreen Exit';
    if (type.startsWith('AI_GAZE')) return '🤖 Eye Gaze Shift';
    if (type.startsWith('AI_DEVICE')) return '📱 Device Detected';
    if (type.startsWith('AI_PEOPLE')) return '👥 Person Anomaly';
    return type.toUpperCase();
}

function updateLiveGrid() {
    if (!document.getElementById('live-pulse-style')) {
        const style = document.createElement('style');
        style.id = 'live-pulse-style';
        style.textContent = `
            @keyframes live-pulse-flag {
                0% { border-color: rgba(239, 68, 68, 0.4); box-shadow: 0 0 5px rgba(239, 68, 68, 0.2); }
                50% { border-color: rgba(239, 68, 68, 1); box-shadow: 0 0 15px rgba(239, 68, 68, 0.5); }
                100% { border-color: rgba(239, 68, 68, 0.4); box-shadow: 0 0 5px rgba(239, 68, 68, 0.2); }
            }
        `;
        document.head.appendChild(style);
    }

    const grid = document.getElementById('live-grid');
    if(!grid) return;

    const sessionIds = Object.keys(liveStudents);
    
    if (sessionIds.length === 0) {
        grid.innerHTML = '<div id="empty-grid-msg" style="color: var(--text-muted); font-size: 14px; grid-column:1/-1; padding:20px 0; text-align:center;">Live queue is currently empty. Waiting for students to authenticate...</div>';
        const activeMetric = document.getElementById('stat-active-sessions');
        if (activeMetric) activeMetric.innerText = 0;
        return;
    }

    // Remove empty message if it exists
    const emptyMsg = document.getElementById('empty-grid-msg');
    if (emptyMsg) emptyMsg.remove();

    // Clean up cards for student sessions that are no longer active
    const cards = grid.querySelectorAll('.student-live-card');
    cards.forEach(card => {
        const id = card.id.replace('student-card-', '');
        if (!liveStudents[id]) {
            card.remove();
        }
    });

    sessionIds.forEach(sessionId => {
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

        let cardStyle = "padding: 16px; background: rgba(30, 41, 59, 0.2); transition: all 0.3s;";
        if (s.status === 'online' && hasFlags) {
            cardStyle += " border: 1.5px solid #ef4444; box-shadow: 0 0 10px rgba(239, 68, 68, 0.3); animation: live-pulse-flag 1.5s infinite;";
        }

        const flagText = (s.status === 'online' && s.lastFlagType) ? `
            <div style="margin-top: 8px; font-size: 11px; padding: 6px 8px; border-radius: 4px; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #ef4444; display: flex; align-items: center; gap: 4px;">
                ⚠️ <strong>Alert:</strong> ${getShortFlagLabel(s.lastFlagType)}
            </div>
        ` : '';

        let card = document.getElementById('student-card-' + sessionId);
        if (!card) {
            // Create a brand new card for this student
            card = document.createElement('div');
            card.id = 'student-card-' + sessionId;
            card.className = `card student-live-card ${ringClass}`;
            card.setAttribute('style', cardStyle);
            card.innerHTML = `
                <div style="display:flex; justify-content:space-between; margin-bottom:10px; align-items:center;">
                    <strong style="font-size: 14px; font-weight:600;">${s.name || 'Testing...'}</strong>
                    <span class="status-dot" style="width: 8px; height: 8px; background: ${statusColor}; border-radius: 50%; display:inline-block; box-shadow: 0 0 6px ${statusColor};"></span>
                </div>
                <div class="card-screenshot-container">${content}</div>
                <div class="card-flag-container">${flagText}</div>
                <div class="card-button-container">${warningBtn}</div>
            `;
            grid.appendChild(card);
        } else {
            // Highly efficient in-place DOM patching
            card.className = `card student-live-card ${ringClass}`;
            card.setAttribute('style', cardStyle);
            
            const dot = card.querySelector('.status-dot');
            if (dot) {
                dot.style.background = statusColor;
                dot.style.boxShadow = `0 0 6px ${statusColor}`;
            }
            
            const screenshotContainer = card.querySelector('.card-screenshot-container');
            if (screenshotContainer) {
                const img = screenshotContainer.querySelector('img');
                if (s.screenshot) {
                    // Only update the image if the screenshot URL has changed to prevent browser image flickering/flashing
                    if (!img || img.src !== s.screenshot) {
                        screenshotContainer.innerHTML = content;
                    }
                } else {
                    if (img || screenshotContainer.innerHTML === '') {
                        screenshotContainer.innerHTML = content;
                    }
                }
            }
            
            const flagContainer = card.querySelector('.card-flag-container');
            if (flagContainer) {
                // Only write if changed to prevent repaint cycles
                if (flagContainer.innerHTML !== flagText) {
                    flagContainer.innerHTML = flagText;
                }
            }
            
            const buttonContainer = card.querySelector('.card-button-container');
            if (buttonContainer) {
                if (buttonContainer.innerHTML !== warningBtn) {
                    buttonContainer.innerHTML = warningBtn;
                }
            }
        }
    });

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
    const audioWarnings = logs.filter(l => l.event_type === 'audio_violation' || l.event_type === 'mic_muted').length;
    const totalWarnings = focusWarnings + aiWarnings + audioWarnings;

    let category = 'low';
    let html = '<span class="badge badge-success">🟢 Low Risk</span>';

    if (totalWarnings > 2 || aiWarnings > 0 || audioWarnings > 0) {
        category = 'high';
        html = `<span class="badge badge-danger" style="box-shadow: 0 0 8px rgba(239, 68, 68, 0.2);">🔴 High Risk (${totalWarnings} flags)</span>`;
    } else if (totalWarnings > 0) {
        category = 'moderate';
        html = `<span class="badge badge-warning">🟡 Mod Risk (${totalWarnings} flags)</span>`;
    }

    return { category, html, totalWarnings, focusWarnings, aiWarnings, audioWarnings };
}

// Proctorio-inspired visual assets
const attemptIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary);" title="Attempt"><line x1="9" y1="6" x2="20" y2="6"></line><line x1="9" y1="12" x2="20" y2="12"></line><line x1="9" y1="18" x2="20" y2="18"></line><path d="M4 6h.01"></path><path d="M4 12h.01"></path><path d="M4 18h.01"></path><path d="M5 21H3a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h2"></path></svg>`;
const scoreIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary);" title="Score"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg>`;
const annotationsIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary);" title="Annotations"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4z"></path></svg>`;
const abnormalitiesIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary);" title="Abnormalities"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"></polygon><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
const trustScoreIcon = `<div style="display:inline-flex; align-items:center; gap:2px; color:var(--text-secondary);" title="Trust Score"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line><circle cx="12" cy="12" r="2" fill="currentColor"></circle></svg><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"></path></svg></div>`;
const alertsIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary);" title="Alerts"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;

const clipboardSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-secondary);" title="Copy Paste Detected"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>`;
const resizeSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-secondary);" title="Browser Resize Detected"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line></svg>`;
const tabSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-secondary);" title="Tab Unfocused"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const robotSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-secondary);" title="AI/Face Alert"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4M8 15h.01M16 15h.01"></path></svg>`;
const audioSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-secondary);" title="Audio/Voice Alert"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;

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
        
        // Trust Score calculation
        const trustScore = Math.max(0, 100 - (riskInfo.totalWarnings * 12));
        let trustBarColor = 'var(--success)';
        if (trustScore < 40) trustBarColor = 'var(--danger)';
        else if (trustScore < 75) trustBarColor = 'var(--warning)';
        
        const trustBarHtml = `<span style="height: 14px; width: 4px; background: ${trustBarColor}; display: inline-block; border-radius: 2px; margin-left: 6px; vertical-align: middle;"></span>`;
        
        // Formatted Submission Date
        const submissionDate = new Date(s.started_at).toLocaleDateString('en-US', {
            month: '2-digit',
            day: '2-digit',
            year: 'numeric'
        });
        
        // Custom Alert Badges aggregation
        const logsList = s.logs || [];
        let alertIconsHtml = '';
        
        const hasCopyPaste = logsList.some(l => l.event_type.includes('clipboard') || l.event_type.includes('copy') || l.event_type.includes('paste'));
        const hasResize = logsList.some(l => l.event_type.includes('resize') || l.event_type.includes('window_resize'));
        const hasUnfocus = logsList.some(l => l.event_type.includes('blur') || l.event_type.includes('tab_switched') || l.event_type.includes('fullscreen_exit'));
        const hasAI = logsList.some(l => l.event_type.startsWith('AI_'));
        const hasAudio = logsList.some(l => l.event_type === 'audio_violation' || l.event_type === 'mic_muted');
        
        if (hasCopyPaste) alertIconsHtml += clipboardSvg;
        if (hasResize) alertIconsHtml += resizeSvg;
        if (hasUnfocus) alertIconsHtml += tabSvg;
        if (hasAI) alertIconsHtml += robotSvg;
        if (hasAudio) alertIconsHtml += audioSvg;
        
        if (!alertIconsHtml) {
            alertIconsHtml = `<span style="color: var(--text-muted); font-size: 12px;">--</span>`;
        } else {
            alertIconsHtml = `<div style="display: flex; gap: 8px; align-items: center;">${alertIconsHtml}</div>`;
        }

        // Available Annotations count
        const annCount = s.annotations ? s.annotations.length : 0;
        
        tbodyHtml += `
            <tr style="border-bottom: 1px solid var(--border); transition: background 0.15s;" onmouseenter="this.style.background='#f8fafc'" onmouseleave="this.style.background='transparent'">
                <td style="padding: 12px 16px;"><input type="checkbox" style="cursor:pointer;" /></td>
                <td style="padding: 12px 16px; cursor: pointer; text-align: center; color: var(--text-secondary);" onclick="viewStudentReport(${s.id}, ${examId})">👁️</td>
                <td style="padding: 12px 16px; font-weight: 700; color: var(--text-primary);">${s.student_name || s.student_canvas_id}</td>
                <td style="padding: 12px 16px; color: var(--text-secondary);">${submissionDate}</td>
                <td style="padding: 12px 16px; color: var(--text-secondary);">6 Months</td>
                <td style="padding: 12px 16px; text-align: center; font-weight: 600;">${s.attempt_number || 1}</td>
                <td style="padding: 12px 16px; text-align: center;">1</td>
                <td style="padding: 12px 16px; text-align: center; font-weight: 600; color: ${annCount > 0 ? 'var(--accent)' : 'var(--text-muted)'};">${annCount}</td>
                <td style="padding: 12px 16px; text-align: center; font-weight: 600; color: ${riskInfo.totalWarnings > 0 ? 'var(--danger)' : 'var(--text-muted)'};">${riskInfo.totalWarnings}</td>
                <td style="padding: 12px 16px; text-align: center; font-weight: 600;">
                    ${trustScore}% ${trustBarHtml}
                </td>
                <td style="padding: 12px 16px;">${alertIconsHtml}</td>
            </tr>
        `;
    });

    if (filtered.length === 0) {
        tbodyHtml = '<tr><td colspan="11" style="text-align:center; padding: 30px; color:var(--text-muted);">No student reports match your filters.</td></tr>';
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
            const studentFlags = logs.filter(l => ['tab_blur', 'window_blur', 'fullscreen_exit', 'audio_violation', 'error', 'fail'].includes(l.event_type) || l.event_type.startsWith('AI_')).length;
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

        // Proctorio-inspired Exam Results UI rendering
        tableContainer.innerHTML = `
            <div style="margin-top: 15px; margin-bottom: 25px;">
                <h2 style="font-size: 22px; font-weight: 800; color: var(--text-primary); margin-bottom: 15px;">ProctorGuard Exam Results</h2>
                
                <!-- Completed Attempts Table Panel -->
                <div style="background: #ffffff; border: 1px solid var(--border); border-radius: var(--radius-lg); margin-bottom: 30px; box-shadow: var(--shadow);">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border);">
                        <div>
                            <strong style="font-size: 15px; color: var(--text-primary);">Completed Attempts</strong>
                            <span style="font-size: 12px; color: var(--text-muted); margin-left: 8px;">(Retention Period: 6 months)</span>
                        </div>
                        <div style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary);">
                            <span>Rows per page:</span>
                            <select class="filter-select" style="padding: 4px 8px; border-radius: 4px; font-size: 12px; background: transparent; border: 1px solid var(--border); outline: none;">
                                <option>25</option>
                                <option>50</option>
                                <option>100</option>
                            </select>
                            <span style="margin-left: 8px; font-weight: 500;">1-${totalAttemptsVal} of ${totalAttemptsVal}</span>
                            <span style="cursor: pointer; opacity: 0.5; font-weight: 700; margin-left: 5px;">&lt;</span>
                            <span style="cursor: pointer; opacity: 0.5; font-weight: 700;">&gt;</span>
                        </div>
                    </div>
                    
                    <div class="table-wrapper" style="overflow-x: auto;">
                        <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 13px;">
                            <thead>
                                <tr style="border-bottom: 2px solid var(--border); background: #f8fafc; font-weight: 700; color: var(--text-secondary);">
                                    <th style="padding: 12px 16px; width: 40px;"><input type="checkbox" style="cursor:pointer;" /></th>
                                    <th style="padding: 12px 16px; width: 40px; text-align: center;">👁️</th>
                                    <th style="padding: 12px 16px;">Name</th>
                                    <th style="padding: 12px 16px;">Submission</th>
                                    <th style="padding: 12px 16px;">Availability</th>
                                    <th style="padding: 12px 16px; text-align: center; width: 70px;">${attemptIcon}</th>
                                    <th style="padding: 12px 16px; text-align: center; width: 70px;">${scoreIcon}</th>
                                    <th style="padding: 12px 16px; text-align: center; width: 70px;">${annotationsIcon}</th>
                                    <th style="padding: 12px 16px; text-align: center; width: 70px;">${abnormalitiesIcon}</th>
                                    <th style="padding: 12px 16px; text-align: center; width: 95px;">${trustScoreIcon}</th>
                                    <th style="padding: 12px 16px; width: 150px;">${alertsIcon}</th>
                                </tr>
                            </thead>
                            <tbody id="report-table-body">
                                <!-- Loaded dynamically -->
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- Deleted Attempts Section -->
                <div style="background: #ffffff; border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow);">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border);">
                        <div>
                            <strong style="font-size: 15px; color: var(--text-primary);">Deleted Attempts</strong>
                            <span style="font-size: 12px; color: var(--text-muted); margin-left: 8px;">(Restoration Period: 24 hours)</span>
                        </div>
                        <div style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary);">
                            <span>Rows per page:</span>
                            <select class="filter-select" style="padding: 4px 8px; border-radius: 4px; font-size: 12px; background: transparent; border: 1px solid var(--border); outline: none;">
                                <option>25</option>
                            </select>
                            <span style="margin-left: 8px; font-weight: 500;">0-0 of 0</span>
                            <span style="cursor: pointer; opacity: 0.3; font-weight: 700; margin-left: 5px;">&lt;</span>
                            <span style="cursor: pointer; opacity: 0.3; font-weight: 700;">&gt;</span>
                        </div>
                    </div>
                    <div style="padding: 40px; text-align: center; color: var(--text-muted); font-size: 13px;">
                        <div style="font-size: 24px; margin-bottom: 10px;">🗑️</div>
                        <strong style="color: var(--text-primary); font-size: 14px;">No Deleted attempts</strong><br>
                        <span style="font-size: 12px; margin-top: 4px; display:inline-block;">Check back later to see if there are any changes</span>
                    </div>
                </div>
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

    const logs = Array.isArray(session.logs) ? session.logs : [];

    // Compute Risk Tier and Score
    let riskScore = 0;
    logs.forEach(log => {
        if (log.event_type === 'phone_detected') riskScore += 50;
        else if (log.event_type === 'multiple_faces') riskScore += 30;
        else if (log.event_type === 'tab_switched' || log.event_type === 'tab_blurred') riskScore += 15;
        else if (log.event_type === 'audio_threshold_exceeded') riskScore += 10;
        else if (log.event_type === 'no_face' || log.event_type === 'AI_PEOPLE') riskScore += 10;
        else if (log.event_type === 'gaze_off_screen') riskScore += 10;
    });
    let riskTier = 'Low';
    let riskBadgeBg = 'rgba(16, 185, 129, 0.15)';
    let riskBadgeColor = '#10b981';
    let riskBadgeBorder = 'rgba(16, 185, 129, 0.3)';
    if (riskScore >= 70) { riskTier = 'High'; riskBadgeBg = 'rgba(239, 68, 68, 0.15)'; riskBadgeColor = '#ef4444'; riskBadgeBorder = 'rgba(239, 68, 68, 0.3)'; }
    else if (riskScore >= 30) { riskTier = 'Medium'; riskBadgeBg = 'rgba(245, 158, 11, 0.15)'; riskBadgeColor = '#f59e0b'; riskBadgeBorder = 'rgba(245, 158, 11, 0.3)'; }

    // Build video layout
    const showVideo = (session.status === 'completed' || session.status === 'abandoned') && !session.video_archived;
    let videoContainerHtml = '';
    if (showVideo) {
        let primaryHtml = '';
        if (session.drive_file_id) {
            primaryHtml = `<iframe src="https://drive.google.com/file/d/${session.drive_file_id}/preview" style="width:100%; height:100%; border:none;" allow="autoplay"></iframe>`;
        } else {
            primaryHtml = `<video src="/api/session/video-playback/${session.id}" controls style="width:100%; height:100%; object-fit:contain;"></video>`;
        }

        if (session.mobile_drive_file_id) {
            let mobileHtml = `<iframe src="https://drive.google.com/file/d/${session.mobile_drive_file_id}/preview" style="width:100%; height:100%; border:none;" allow="autoplay"></iframe>`;
            videoContainerHtml = `
                <div style="display: flex; gap: 15px; flex-wrap: wrap; width: 100%; margin-bottom: 20px;">
                    <div style="flex: 1; min-width: 280px;">
                        <div style="font-size: 11px; font-weight: 600; color: #94a3b8; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; gap: 5px;"><img src="icons/record-screen.svg" style="width:14px; height:14px; filter: brightness(0.7);" /> Primary Laptop Screen / Webcam</div>
                        <div style="background: #000; border-radius: 8px; overflow: hidden; aspect-ratio: 16/9; border: 1px solid #334155;">${primaryHtml}</div>
                    </div>
                    <div style="flex: 1; min-width: 280px;">
                        <div style="font-size: 11px; font-weight: 600; color: #94a3b8; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; gap: 5px;"><img src="icons/secondary-mobile-camera.svg" style="width:14px; height:14px; filter: brightness(0.7);" /> Secondary Mobile Room View</div>
                        <div style="background: #000; border-radius: 8px; overflow: hidden; aspect-ratio: 16/9; border: 1px solid #334155;">${mobileHtml}</div>
                    </div>
                </div>`;
        } else {
            videoContainerHtml = `
                <div style="width: 100%; margin-bottom: 20px;">
                    <div style="font-size: 11px; font-weight: 600; color: #94a3b8; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; gap: 5px;"><img src="icons/record-screen.svg" style="width:14px; height:14px; filter: brightness(0.7);" /> Webcam / Screen Recording</div>
                    <div style="background: #000; border-radius: 8px; overflow: hidden; aspect-ratio: 16/9; border: 1px solid #334155;">${primaryHtml}</div>
                </div>`;
        }
    } else {
        videoContainerHtml = `
            <div style="margin-bottom: 20px; background: rgba(255, 255, 255, 0.02); border: 1px dashed #334155; border-radius: 8px; padding: 30px; text-align: center; color: #94a3b8;">
                <span style="font-size: 32px; display:block; margin-bottom: 8px;">🎥</span>
                ${session.video_archived ? '<strong style="color:#f8fafc;">Video Footage Archived Off-Site</strong><br><span style="font-size:12px;">This recording was hard purged to reclaim storage space.</span>' : '<strong style="color:#f8fafc;">Video Recording Finalizing...</strong><br><span style="font-size:12px;">The footage is still being assembled and uploaded in the background.</span>'}
            </div>`;
    }

    // Extra panels (room scan, snapshots, ID verification, signature)
    let extraPanelsHtml = '';
    const roomScanLog = logs.find(l => l.event_type === 'room_scan_video');
    if (roomScanLog) {
        extraPanelsHtml += `
            <div style="background: rgba(139, 92, 246, 0.08); border: 1px solid rgba(139, 92, 246, 0.2); border-radius: 8px; padding: 16px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <div>
                    <h5 style="margin:0; font-size:13px; font-weight:700; color:#c084fc;">Environment Room Scan</h5>
                    <p style="margin: 4px 0 0 0; font-size:11px; color:#94a3b8;">360&deg; workspace scan completed before starting the exam.</p>
                </div>
                <a href="${roomScanLog.event_message}" target="_blank" style="background: #8b5cf6; color: white; padding: 6px 12px; border-radius: 6px; font-weight: bold; text-decoration: none; font-size: 12px; display: inline-flex; align-items: center; gap: 5px;">
                    👁️ View Scan
                </a>
            </div>`;
    }
    const idVerificationLog = logs.find(l => l.event_type === 'verify_id_image');
    if (idVerificationLog) {
        extraPanelsHtml += `
            <div style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 8px; padding: 16px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <div>
                    <h5 style="margin:0; font-size:13px; font-weight:700; color:#34d399;">ID Verification Card</h5>
                    <p style="margin: 4px 0 0 0; font-size:11px; color:#94a3b8;">Government or student ID image captured during pre-checks.</p>
                </div>
                <a href="${idVerificationLog.event_message}" target="_blank" style="background: #10b981; color: white; padding: 6px 12px; border-radius: 6px; font-weight: bold; text-decoration: none; font-size: 12px; display: inline-flex; align-items: center; gap: 5px;">
                    👁️ View ID Image
                </a>
            </div>`;
    }
    const signatureLog = logs.find(l => l.event_type === 'verify_signature_image');
    if (signatureLog) {
        extraPanelsHtml += `
            <div style="background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.2); border-radius: 8px; padding: 16px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <div>
                    <h5 style="margin:0; font-size:13px; font-weight:700; color:#fbbf24;">Signature Agreement</h5>
                    <p style="margin: 4px 0 0 0; font-size:11px; color:#94a3b8;">Digitally signed agreement before exam launch.</p>
                </div>
                <a href="${signatureLog.event_message}" target="_blank" style="background: #f59e0b; color: white; padding: 6px 12px; border-radius: 6px; font-weight: bold; text-decoration: none; font-size: 12px; display: inline-flex; align-items: center; gap: 5px;">
                    👁️ View Signature
                </a>
            </div>`;
    }
    if (session.drive_snapshots_id) {
        extraPanelsHtml += `
            <div style="background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 8px; padding: 16px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <div>
                    <h5 style="margin:0; font-size:13px; font-weight:700; color:#60a5fa;">DOM Quiz Screenshots</h5>
                    <p style="margin: 4px 0 0 0; font-size:11px; color:#94a3b8;">ZIP folder containing full-page quiz capture screenshots.</p>
                </div>
                <a href="https://drive.google.com/uc?export=download&id=${session.drive_snapshots_id}" target="_blank" style="background: #3b82f6; color: white; padding: 6px 12px; border-radius: 6px; font-weight: bold; text-decoration: none; font-size: 12px; display: inline-flex; align-items: center; gap: 5px;">
                    📥 Download ZIP
                </a>
            </div>`;
    }

    // Metrics stats
    const gazeCount = logs.filter(l => l.event_type.startsWith('AI_GAZE')).length;
    const deviceCount = logs.filter(l => l.event_type.startsWith('AI_DEVICE')).length;
    const voiceCount = logs.filter(l => l.event_type === 'audio_violation').length;
    const focusCount = logs.filter(l => ['tab_blur', 'window_blur', 'fullscreen_exit'].includes(l.event_type)).length;

    const modalContentHtml = `
        <div style="background: #0f172a; border-bottom: 1px solid #334155; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; border-radius: 12px 12px 0 0;">
            <div style="display: flex; align-items: center; gap: 15px;">
                <h2 style="margin: 0; font-size: 18px; font-weight: 600; color: #3b82f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">Proctored Exam Report: ${session.student_name || session.student_canvas_id}</h2>
                <span style="padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: bold; background: ${riskBadgeBg}; color: ${riskBadgeColor}; border: 1px solid ${riskBadgeBorder}; text-transform: uppercase; letter-spacing: 0.05em;">
                    Risk: ${riskTier} (${riskScore})
                </span>
            </div>
            <div style="display: flex; align-items: center; gap: 12px;">
                <span style="font-size: 12px; color: #94a3b8; font-family: monospace;">Exam: ${exam.title} | Attempt ${session.attempt_number || 1} | ${new Date(session.started_at).toLocaleString()}</span>
                <button class="modal-close" onclick="closeModal()" style="background: transparent; border: none; color: #94a3b8; font-size: 28px; cursor: pointer; line-height: 1;">&times;</button>
            </div>
        </div>
        <div style="display: flex; flex: 1; overflow: hidden; background: #1e293b;">
            <!-- Left Pane: Media & Downloads -->
            <div style="flex: 6.5; padding: 24px; background: #090d16; display: flex; flex-direction: column; overflow-y: auto; border-right: 1px solid #334155;">
                ${videoContainerHtml}
                ${extraPanelsHtml}
            </div>

            <!-- Right Pane: Timeline & Filters & Annotations -->
            <div style="flex: 3.5; display: flex; flex-direction: column; background: #0f172a; overflow: hidden;">
                <!-- Tabbar -->
                <div style="display: flex; background: #0b0f19; border-bottom: 1px solid #334155;">
                    <button id="tab-timeline-btn" onclick="switchReportTab('timeline')" style="flex: 1; padding: 12px; border: none; background: transparent; color: #3b82f6; border-bottom: 2px solid #3b82f6; font-weight: 700; font-size: 13px; cursor: pointer; outline: none;">Timeline</button>
                    <button id="tab-annotations-btn" onclick="switchReportTab('annotations')" style="flex: 1; padding: 12px; border: none; background: transparent; color: #94a3b8; border-bottom: 2px solid transparent; font-weight: 500; font-size: 13px; cursor: pointer; outline: none;">Annotations (${session.annotations ? session.annotations.length : 0})</button>
                </div>
                
                <!-- Timeline Section Container -->
                <div id="report-timeline-container" style="display: flex; flex-direction: column; flex: 1; overflow: hidden;">
                    <div style="padding: 16px; border-bottom: 1px solid #334155;">
                        <h4 style="margin: 0 0 10px 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8;">Proctoring Log Timeline</h4>

                        <!-- Metrics -->
                        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 12px;">
                            <div style="background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.15); padding: 6px 4px; border-radius: 6px; text-align: center;">
                                <div style="font-size: 13px; font-weight: 700; color: #f8fafc;">${gazeCount}</div>
                                <div style="font-size: 8px; color: #94a3b8; text-transform: uppercase;">Gaze</div>
                            </div>
                            <div style="background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.15); padding: 6px 4px; border-radius: 6px; text-align: center;">
                                <div style="font-size: 13px; font-weight: 700; color: #f8fafc;">${deviceCount}</div>
                                <div style="font-size: 8px; color: #94a3b8; text-transform: uppercase;">Devices</div>
                            </div>
                            <div style="background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.15); padding: 6px 4px; border-radius: 6px; text-align: center;">
                                <div style="font-size: 13px; font-weight: 700; color: #f8fafc;">${voiceCount}</div>
                                <div style="font-size: 8px; color: #94a3b8; text-transform: uppercase;">Speaking</div>
                            </div>
                            <div style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.15); padding: 6px 4px; border-radius: 6px; text-align: center;">
                                <div style="font-size: 13px; font-weight: 700; color: #f8fafc;">${focusCount}</div>
                                <div style="font-size: 8px; color: #94a3b8; text-transform: uppercase;">Tab Leaves</div>
                            </div>
                        </div>

                        <!-- Search & Filter -->
                        <div style="display: flex; gap: 8px;">
                            <input type="text" id="log-search-input" placeholder="Search events..." style="flex: 1; padding: 8px 12px; background: #1e293b; border: 1px solid #475569; border-radius: 6px; color: #f8fafc; font-size: 13px; box-sizing: border-box; outline: none;" />
                            <select id="log-severity-select" style="padding: 8px 12px; background: #1e293b; border: 1px solid #475569; border-radius: 6px; color: #f8fafc; font-size: 13px; cursor: pointer;">
                                <option value="all">All Events</option>
                                <option value="flag">Warnings / Flags</option>
                                <option value="info">Info Logs</option>
                            </select>
                        </div>
                    </div>
                    <div id="modal-timeline-list" style="flex: 1; overflow-y: auto; padding: 12px;">
                        <!-- Rendered dynamically -->
                    </div>
                </div>

                <!-- Annotations Section Container -->
                <div id="report-annotations-container" style="display: none; flex-direction: column; flex: 1; overflow: hidden;">
                    <div style="padding: 16px; border-bottom: 1px solid #334155; display: flex; flex-direction: column; gap: 8px;">
                        <div style="display: flex; gap: 8px;">
                            <input type="text" id="new-annotation-note" placeholder="Add note at current playback time..." style="flex: 1; padding: 8px 12px; background: #1e293b; border: 1px solid #475569; border-radius: 6px; color: #f8fafc; font-size: 13px; outline: none; box-sizing: border-box;" />
                            <button onclick="addAnnotation(${session.id}, ${exam.id})" style="padding: 8px 16px; background: #3b82f6; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 13px;">Add</button>
                        </div>
                        <div style="font-size: 11px; color: #94a3b8;">Annotations will lock to the exact video playback timestamp.</div>
                    </div>
                    <div id="modal-annotations-list" style="flex: 1; overflow-y: auto; padding: 12px;">
                        <!-- Rendered dynamically -->
                    </div>
                </div>
            </div>
        </div>
        <div style="background: #0f172a; border-top: 1px solid #334155; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; border-radius: 0 0 12px 12px;">
            <div style="display:flex; gap: 8px;">
                <button class="btn btn-secondary btn-sm" onclick="grantExtraAttempt(${exam.id}, '${session.student_canvas_id}')" style="background: rgba(100, 116, 139, 0.15); color: #94a3b8; border: 1px solid #475569;">+1 Override Pass</button>
                <button class="btn btn-danger btn-sm" onclick="deleteStudentAttempt(${session.id}, ${exam.id})" style="background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2);">Delete Session</button>
            </div>
            <button class="btn btn-primary btn-sm" onclick="closeModal()" style="background: #3b82f6; color: white; border: none;">Done</button>
        </div>
    `;
    
    const modalOverlay = document.getElementById('modal-overlay');
    const modalContainer = document.getElementById('modal-content');
    modalContainer.style.maxWidth = '1200px';
    modalContainer.style.width = '95%';
    modalContainer.style.padding = '0';
    modalContainer.style.background = '#1e293b';
    modalContainer.style.border = '1px solid #334155';
    modalContainer.style.borderRadius = '12px';
    modalContainer.style.display = 'flex';
    modalContainer.style.flexDirection = 'column';
    modalContainer.style.height = '85vh';
    modalContainer.style.overflow = 'hidden';
    modalContainer.innerHTML = modalContentHtml;
    modalOverlay.classList.add('active');

    // Register active session-level timeline controllers
    window.switchReportTab = function(tabName) {
        const timelineBtn = document.getElementById('tab-timeline-btn');
        const annotationsBtn = document.getElementById('tab-annotations-btn');
        const timelineContainer = document.getElementById('report-timeline-container');
        const annotationsContainer = document.getElementById('report-annotations-container');
        
        if (tabName === 'timeline') {
            timelineBtn.style.color = '#3b82f6';
            timelineBtn.style.borderBottom = '2px solid #3b82f6';
            timelineBtn.style.fontWeight = '700';
            annotationsBtn.style.color = '#94a3b8';
            annotationsBtn.style.borderBottom = '2px solid transparent';
            annotationsBtn.style.fontWeight = '500';
            timelineContainer.style.display = 'flex';
            annotationsContainer.style.display = 'none';
        } else {
            timelineBtn.style.color = '#94a3b8';
            timelineBtn.style.borderBottom = '2px solid transparent';
            timelineBtn.style.fontWeight = '500';
            annotationsBtn.style.color = '#3b82f6';
            annotationsBtn.style.borderBottom = '2px solid #3b82f6';
            annotationsBtn.style.fontWeight = '700';
            timelineContainer.style.display = 'none';
            annotationsContainer.style.display = 'flex';
            renderAnnotations(session.id);
        }
    };

    window.seekVideo = function(seconds) {
        const video = document.getElementById('report-video-player');
        if (video) {
            video.currentTime = seconds;
            video.play().catch(() => {});
        } else {
            showToast("Primary video player not active or loading.", "info");
        }
    };

    window.renderAnnotations = async function(sessionId) {
        const list = document.getElementById('modal-annotations-list');
        if (!list) return;
        list.innerHTML = '<div style="text-align:center; padding:20px; color:#94a3b8;"><div class="spinner"></div></div>';
        
        try {
            const res = await apiFetch(`/api/session/${sessionId}/annotations`);
            const data = await res.json();
            const annotations = data.annotations || [];
            
            // Update counts on tabbar
            const sessionInList = currentSessionsList.find(s => s.id == sessionId);
            if (sessionInList) {
                sessionInList.annotations = annotations;
                const annTabBtn = document.getElementById('tab-annotations-btn');
                if (annTabBtn) annTabBtn.innerText = `Annotations (${annotations.length})`;
            }
            
            if (annotations.length === 0) {
                list.innerHTML = '<div style="text-align:center; padding:35px; color:#94a3b8; font-size:13px;">No annotations left on this session yet. Type above to add one.</div>';
                return;
            }
            
            let html = '';
            annotations.forEach(a => {
                const min = Math.floor(a.timestamp_seconds / 60);
                const sec = a.timestamp_seconds % 60;
                const timeStr = min + ':' + sec.toString().padStart(2, '0');
                
                html += `
                    <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid #334155; padding: 12px; border-radius: 8px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;">
                        <div>
                            <span style="font-family: monospace; font-size:12px; font-weight:700; color:#3b82f6; cursor:pointer; text-decoration: underline;" onclick="seekVideo(${a.timestamp_seconds})">[${timeStr}]</span>
                            <p style="margin: 4px 0 0 0; color:#f8fafc; font-size:13px; line-height: 1.4; word-break: break-word;">${a.note}</p>
                        </div>
                        <button onclick="deleteAnnotation(${a.id}, ${sessionId})" style="background:transparent; border:none; color:#ef4444; font-size:18px; cursor:pointer; line-height:1;" title="Delete note">&times;</button>
                    </div>
                `;
            });
            list.innerHTML = html;
        } catch (err) {
            list.innerHTML = '<div style="text-align:center; padding:20px; color:var(--danger);">Error loading annotations.</div>';
        }
    };

    window.addAnnotation = async function(sessionId, examId) {
        const noteInput = document.getElementById('new-annotation-note');
        if (!noteInput) return;
        const note = noteInput.value.trim();
        if (!note) {
            showToast("Annotation note cannot be empty", "warning");
            return;
        }
        
        const video = document.getElementById('report-video-player');
        const timestamp_seconds = video ? Math.floor(video.currentTime) : 0;
        
        try {
            const res = await apiFetch(`/api/session/${sessionId}/annotations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ timestamp_seconds, note })
            });
            if (res.ok) {
                noteInput.value = '';
                showToast("Annotation added successfully.", "success");
                await renderAnnotations(sessionId);
                filterReports(examId);
            } else {
                showToast("Failed to add annotation", "warning");
            }
        } catch (err) {
            console.error(err);
            showToast("Error adding annotation", "warning");
        }
    };

    window.deleteAnnotation = async function(annotationId, sessionId) {
        if (!confirm("Are you sure you want to delete this annotation?")) return;
        try {
            const res = await apiFetch(`/api/session/${sessionId}/annotations/${annotationId}`, { method: 'DELETE' });
            if (res.ok) {
                showToast("Annotation deleted.", "success");
                await renderAnnotations(sessionId);
                if (currentLiveExamId) filterReports(currentLiveExamId);
            } else {
                showToast("Failed to delete annotation", "warning");
            }
        } catch (err) {
            console.error(err);
            showToast("Error deleting annotation", "warning");
        }
    };

    // Render logs timeline
    const renderLogsTimeline = () => {
        const timelineLogs = Array.isArray(session.logs) ? session.logs : [];
        const container = document.getElementById('modal-timeline-list');
        if (!container) return;

        let filteredLogs = timelineLogs;

        if (activeLogFilterSearch) {
            const query = activeLogFilterSearch.toLowerCase();
            filteredLogs = filteredLogs.filter(l => 
                l.event_message.toLowerCase().includes(query) || 
                l.event_type.toLowerCase().includes(query)
            );
        }

        if (activeLogFilterSeverity === 'flag') {
            filteredLogs = filteredLogs.filter(l => 
                ['tab_blur', 'window_blur', 'fullscreen_exit', 'audio_violation', 'error', 'fail'].includes(l.event_type) || 
                l.event_type.startsWith('AI_')
            );
        } else if (activeLogFilterSeverity === 'info') {
            filteredLogs = filteredLogs.filter(l => 
                !['tab_blur', 'window_blur', 'fullscreen_exit', 'audio_violation', 'error', 'fail'].includes(l.event_type) && 
                !l.event_type.startsWith('AI_')
            );
        }

        let logsHtml = '';
        filteredLogs.forEach(l => {
            if (l.event_type === 'room_scan_video') return;

            const isAI = l.event_type.startsWith('AI_');
            const isDanger = ['tab_blur', 'window_blur', 'fullscreen_exit', 'audio_violation', 'mic_muted', 'booted', 'error', 'fail', 'phone_detected', 'multiple_faces'].includes(l.event_type) || isAI;
            const isWarning = ['audio_threshold_exceeded', 'gaze_off_screen'].includes(l.event_type) || l.event_type.includes('transcript') || l.event_type.includes('voice') || l.event_type.includes('speaking') || l.event_type.includes('blur') || l.event_type.includes('focus');

            let borderColor = '#3b82f6';
            let bgColor = 'rgba(59, 130, 246, 0.05)';
            if (isDanger) { borderColor = '#ef4444'; bgColor = 'rgba(239, 68, 68, 0.05)'; }
            else if (isWarning) { borderColor = '#f59e0b'; bgColor = 'rgba(245, 158, 11, 0.05)'; }

            // Calculate video offset
            const offsetSec = Math.max(0, Math.floor((new Date(l.event_timestamp) - new Date(session.started_at)) / 1000));
            const min = Math.floor(offsetSec / 60);
            const sec = offsetSec % 60;
            const timeStr = min + ':' + sec.toString().padStart(2, '0');

            logsHtml += `
                <div style="padding: 10px 12px; margin-bottom: 8px; border-radius: 8px; background: ${bgColor}; border-left: 4px solid ${borderColor}; cursor: pointer; transition: transform 0.15s, background 0.15s;"
                     onclick="seekVideo(${offsetSec})"
                     onmouseenter="this.style.transform='translateX(4px)'; this.style.background='#334155';"
                     onmouseleave="this.style.transform='translateX(0)'; this.style.background='${bgColor}';">
                    <div style="font-size: 11px; color: #94a3b8; margin-bottom: 4px;">[${timeStr}] - ${l.event_type.replace(/_/g, ' ').toUpperCase()}</div>
                    <div style="font-size: 12px; line-height: 1.4; color: #f8fafc; word-break: break-word;">${l.event_message}</div>
                </div>
            `;
        });

        if (filteredLogs.filter(l => l.event_type !== 'room_scan_video').length === 0) {
            logsHtml = `<div style="text-align:center; padding:20px; color:#94a3b8; font-size:13px;">No matching events found.</div>`;
        }
        container.innerHTML = logsHtml;
    };

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

function showCreateExamModal(examId = null) {
    const exam = examId ? exams.find(e => e.id == examId) : null;
    const defaultCode = exam ? exam.exam_code : Math.random().toString(36).substring(2, 8).toUpperCase();
    
    // Set wider modal size for spacious card layout
    const modalContainer = document.getElementById('modal-content');
    modalContainer.style.maxWidth = '900px';
    modalContainer.style.width = '95%';

    // Settings values
    const verifyVideo = exam ? exam.verify_video : false;
    const verifyAudio = exam ? exam.verify_audio : false;
    const verifyDesktop = exam ? exam.verify_desktop : false;
    const verifyId = exam ? exam.verify_id : false;
    const verifySignature = exam ? exam.verify_signature : false;
    const allowCalculator = exam ? exam.allow_calculator : false;
    const allowWhiteboard = exam ? exam.allow_whiteboard : false;
    const behaviorPreset = exam ? exam.behavior_preset : 'Recommended';
    
    const weightNavigatingAway = exam && exam.weight_navigating_away !== undefined ? exam.weight_navigating_away : 3;
    const weightKeystrokes = exam && exam.weight_keystrokes !== undefined ? exam.weight_keystrokes : 1;
    const weightCopyPaste = exam && exam.weight_copy_paste !== undefined ? exam.weight_copy_paste : 4;
    const weightBrowserResize = exam && exam.weight_browser_resize !== undefined ? exam.weight_browser_resize : 2;
    const weightHeadMovement = exam && exam.weight_head_movement !== undefined ? exam.weight_head_movement : 2;
    const weightMultiFace = exam && exam.weight_multi_face !== undefined ? exam.weight_multi_face : 3;
    const weightLeavingRoom = exam && exam.weight_leaving_room !== undefined ? exam.weight_leaving_room : 3;

    const html = `
        <div class="modal-header">
            <h2 class="modal-title" style="font-family:'Outfit', sans-serif; font-size:20px; font-weight:700;">${exam ? 'Edit Exam Settings' : 'Enable Proctoring'}</h2>
            <button class="modal-close" onclick="closeModal()">×</button>
        </div>
        <div style="max-height: 70vh; overflow-y: auto; padding-right: 8px;">
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
            </div>
            <div class="form-group">
                <label class="form-label">Canvas Quiz Password / Access Code (Optional)</label>
                <input type="text" id="quiz-password" class="form-input" placeholder="e.g. SECURE-WWI-QUIZ" value="${exam && exam.canvas_quiz_password ? exam.canvas_quiz_password : ''}">
                <div class="form-hint">If your Canvas quiz requires a password/access code to start, enter it here.</div>
            </div>
            
            <!-- Accordion Section 1: Proctorio Exam Settings -->
            <div class="proctorio-section" id="section-exam-settings">
                <div class="proctorio-section-header" onclick="toggleProctorioSection('section-exam-settings')">
                    <div class="proctorio-section-title-container">
                        <span class="proctorio-toggle-icon">▼</span>
                        <div>
                            <div class="proctorio-section-title">Proctorio Exam Settings</div>
                            <div class="proctorio-section-subtitle">Exam settings cannot be changed once the first candidate has started the exam.</div>
                        </div>
                    </div>
                </div>
                <div class="proctorio-section-content">
                    <!-- Recording Options -->
                    <h4 style="margin: 0 0 6px 0; font-family:'Outfit',sans-serif; font-size:13px; font-weight:700; color:var(--text-primary);">Recording Options</h4>
                    <p style="font-size:11px; color:var(--text-muted); margin-bottom: 12px;">Select what student activities will be recorded during the exam.</p>
                    <div class="proctorio-grid">
                        <div class="proctorio-card ${!exam || exam.require_camera ? 'selected' : ''}" id="card-camera" onclick="toggleProctorioOption('chk-camera', 'card-camera')" title="Record student webcam">
                            <div class="proctorio-icon"><img src="icons/record-video.svg" alt="" /></div>
                            <div class="proctorio-title">Record Video</div>
                            <input type="checkbox" id="chk-camera" ${!exam || exam.require_camera ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${!exam || exam.require_mic ? 'selected' : ''}" id="card-mic" onclick="toggleProctorioOption('chk-mic', 'card-mic')" title="Record student microphone">
                            <div class="proctorio-icon"><img src="icons/record-audio.svg" alt="" /></div>
                            <div class="proctorio-title">Record Audio</div>
                            <input type="checkbox" id="chk-mic" ${!exam || exam.require_mic ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${!exam || exam.require_screen ? 'selected' : ''}" id="card-screen" onclick="toggleProctorioOption('chk-screen', 'card-screen')" title="Record full desktop screen">
                            <div class="proctorio-icon"><img src="icons/record-screen.svg" alt="" /></div>
                            <div class="proctorio-title">Record Screen</div>
                            <input type="checkbox" id="chk-screen" ${!exam || exam.require_screen ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.record_web_traffic ? 'selected' : ''}" id="card-ext-traffic" onclick="toggleProctorioOption('chk-ext-traffic', 'card-ext-traffic')" title="Record all visited URLs">
                            <div class="proctorio-icon"><img src="icons/record-web-traffic.svg" alt="" /></div>
                            <div class="proctorio-title">Record Web Traffic</div>
                            <input type="checkbox" id="chk-ext-traffic" ${exam && exam.record_web_traffic ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.require_room_scan ? 'selected' : ''}" id="card-room-scan" onclick="toggleProctorioOption('chk-room-scan', 'card-room-scan')" title="Require environment check video before starting">
                            <div class="proctorio-icon"><img src="icons/room-scan.svg" alt="" /></div>
                            <div class="proctorio-title">Record Desk</div>
                            <input type="checkbox" id="chk-room-scan" ${exam && exam.require_room_scan ? 'checked' : ''} style="display:none;" />
                        </div>
                    </div>

                    <!-- Lock Down Options -->
                    <h4 style="margin: 20px 0 6px 0; font-family:'Outfit',sans-serif; font-size:13px; font-weight:700; color:var(--text-primary);">Lock Down Options</h4>
                    <p style="font-size:11px; color:var(--text-muted); margin-bottom: 12px;">Enforce strict browser behavior guidelines during the assessment.</p>
                    <div class="proctorio-grid" style="grid-template-columns: repeat(5, 1fr);">
                        <div class="proctorio-card ${!exam || exam.require_fullscreen ? 'selected' : ''}" id="card-fs" onclick="toggleProctorioOption('chk-fs', 'card-fs')" title="Prevent window resizing">
                            <div class="proctorio-icon"><img src="icons/force-fullscreen.svg" alt="" /></div>
                            <div class="proctorio-title">Force Full Screen</div>
                            <input type="checkbox" id="chk-fs" ${!exam || exam.require_fullscreen ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.only_one_screen ? 'selected' : ''}" id="card-one-screen" onclick="toggleProctorioOption('chk-one-screen', 'card-one-screen')" title="Block secondary/dual displays">
                            <div class="proctorio-icon"><img src="icons/only-one-screen.svg" alt="" /></div>
                            <div class="proctorio-title">Only One Screen</div>
                            <input type="checkbox" id="chk-one-screen" ${exam && exam.only_one_screen ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.disable_new_tabs ? 'selected' : ''}" id="card-ext-newtabs" onclick="toggleProctorioOption('chk-ext-newtabs', 'card-ext-newtabs')" title="Prevent opening new tabs">
                            <div class="proctorio-icon"><img src="icons/disable-new-tabs.svg" alt="" /></div>
                            <div class="proctorio-title">Disable New Tabs</div>
                            <input type="checkbox" id="chk-ext-newtabs" ${exam && exam.disable_new_tabs ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.close_open_tabs ? 'selected' : ''}" id="card-ext-closetabs" onclick="toggleProctorioOption('chk-ext-closetabs', 'card-ext-closetabs')" title="Force close all other open tabs">
                            <div class="proctorio-icon"><img src="icons/close-open-tabs.svg" alt="" /></div>
                            <div class="proctorio-title">Close Open Tabs</div>
                            <input type="checkbox" id="chk-ext-closetabs" ${exam && exam.close_open_tabs ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.disable_printing ? 'selected' : ''}" id="card-printing" onclick="toggleProctorioOption('chk-printing', 'card-printing')" title="Block and hide printing">
                            <div class="proctorio-icon"><img src="icons/disable-printing.svg" alt="" /></div>
                            <div class="proctorio-title">Disable Printing</div>
                            <input type="checkbox" id="chk-printing" ${exam && exam.disable_printing ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.disable_clipboard ? 'selected' : ''}" id="card-clipboard" onclick="toggleProctorioOption('chk-clipboard', 'card-clipboard')" title="Block copy, cut, and paste">
                            <div class="proctorio-icon"><img src="icons/disable-clipboard.svg" alt="" /></div>
                            <div class="proctorio-title">Disable Clipboard</div>
                            <input type="checkbox" id="chk-clipboard" ${exam && exam.disable_clipboard ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.block_downloads ? 'selected' : ''}" id="card-downloads" onclick="toggleProctorioOption('chk-downloads', 'card-downloads')" title="Block file downloading">
                            <div class="proctorio-icon"><img src="icons/block-downloads.svg" alt="" /></div>
                            <div class="proctorio-title">Block Downloads</div>
                            <input type="checkbox" id="chk-downloads" ${exam && exam.block_downloads ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.clear_cache ? 'selected' : ''}" id="card-ext-cache" onclick="toggleProctorioOption('chk-ext-cache', 'card-ext-cache')" title="Clear browser cache upon completion">
                            <div class="proctorio-icon"><img src="icons/clear-cache.svg" alt="" /></div>
                            <div class="proctorio-title">Clear Cache</div>
                            <input type="checkbox" id="chk-ext-cache" ${exam && exam.clear_cache ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${!exam || exam.disable_right_click ? 'selected' : ''}" id="card-rc" onclick="toggleProctorioOption('chk-rc', 'card-rc')" title="Block right click / context menu">
                            <div class="proctorio-icon"><img src="icons/block-navigation.svg" alt="" /></div>
                            <div class="proctorio-title">Disable Right Click</div>
                            <input type="checkbox" id="chk-rc" ${!exam || exam.disable_right_click ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${exam && exam.prevent_reentry ? 'selected' : ''}" id="card-reentry" onclick="toggleProctorioOption('chk-reentry', 'card-reentry')" title="Block re-entry after exit">
                            <div class="proctorio-icon"><img src="icons/prevent-reentry.svg" alt="" /></div>
                            <div class="proctorio-title">Prevent Re-entry</div>
                            <input type="checkbox" id="chk-reentry" ${exam && exam.prevent_reentry ? 'checked' : ''} style="display:none;" />
                        </div>
                    </div>

                    <!-- Verification Options -->
                    <h4 style="margin: 20px 0 6px 0; font-family:'Outfit',sans-serif; font-size:13px; font-weight:700; color:var(--text-primary);">Verification Options</h4>
                    <p style="font-size:11px; color:var(--text-muted); margin-bottom: 12px;">Confirm candidate identities and system functionality before exam begins.</p>
                    <div class="proctorio-grid">
                        <div class="proctorio-card ${verifyVideo ? 'selected' : ''}" id="card-verify-video" onclick="toggleProctorioOption('chk-verify-video', 'card-verify-video')" title="Verify camera feed">
                            <div class="proctorio-icon"><img src="icons/record-video.svg" alt="" /></div>
                            <div class="proctorio-title">Verify Video</div>
                            <input type="checkbox" id="chk-verify-video" ${verifyVideo ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${verifyAudio ? 'selected' : ''}" id="card-verify-audio" onclick="toggleProctorioOption('chk-verify-audio', 'card-verify-audio')" title="Verify microphone level">
                            <div class="proctorio-icon"><img src="icons/record-audio.svg" alt="" /></div>
                            <div class="proctorio-title">Verify Audio</div>
                            <input type="checkbox" id="chk-verify-audio" ${verifyAudio ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${verifyDesktop ? 'selected' : ''}" id="card-verify-desktop" onclick="toggleProctorioOption('chk-verify-desktop', 'card-verify-desktop')" title="Verify screen sharing">
                            <div class="proctorio-icon"><img src="icons/record-screen.svg" alt="" /></div>
                            <div class="proctorio-title">Verify Desktop</div>
                            <input type="checkbox" id="chk-verify-desktop" ${verifyDesktop ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${verifyId ? 'selected' : ''}" id="card-verify-id" onclick="toggleProctorioOption('chk-verify-id', 'card-verify-id')" title="Verify candidate photo ID card">
                            <div class="proctorio-icon"><img src="icons/secondary-mobile-camera.svg" alt="" /></div>
                            <div class="proctorio-title">Verify ID</div>
                            <input type="checkbox" id="chk-verify-id" ${verifyId ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${verifySignature ? 'selected' : ''}" id="card-verify-signature" onclick="toggleProctorioOption('chk-verify-signature', 'card-verify-signature')" title="Verify candidate digital signature">
                            <div class="proctorio-icon"><img src="icons/block-navigation.svg" alt="" /></div>
                            <div class="proctorio-title">Verify Signature</div>
                            <input type="checkbox" id="chk-verify-signature" ${verifySignature ? 'checked' : ''} style="display:none;" />
                        </div>
                    </div>

                    <!-- In-Quiz Tools -->
                    <h4 style="margin: 20px 0 6px 0; font-family:'Outfit',sans-serif; font-size:13px; font-weight:700; color:var(--text-primary);">In-Quiz Tools</h4>
                    <p style="font-size:11px; color:var(--text-muted); margin-bottom: 12px;">Allowed digital tools for students within the secure frame.</p>
                    <div class="proctorio-grid" style="grid-template-columns: repeat(6, 1fr);">
                        <div class="proctorio-card ${allowCalculator ? 'selected' : ''}" id="card-allow-calculator" onclick="toggleProctorioOption('chk-allow-calculator', 'card-allow-calculator')" title="Provide scientific calculator tool">
                            <div class="proctorio-icon">📊</div>
                            <div class="proctorio-title">Calculator</div>
                            <input type="checkbox" id="chk-allow-calculator" ${allowCalculator ? 'checked' : ''} style="display:none;" />
                        </div>
                        <div class="proctorio-card ${allowWhiteboard ? 'selected' : ''}" id="card-allow-whiteboard" onclick="toggleProctorioOption('chk-allow-whiteboard', 'card-allow-whiteboard')" title="Provide digital whiteboard notepad">
                            <div class="proctorio-icon">📝</div>
                            <div class="proctorio-title">Whiteboard</div>
                            <input type="checkbox" id="chk-allow-whiteboard" ${allowWhiteboard ? 'checked' : ''} style="display:none;" />
                        </div>
                    </div>
                </div>
            </div>

            <!-- Accordion Section 2: Proctorio Behavior Settings -->
            <div class="proctorio-section collapsed" id="section-behavior-settings">
                <div class="proctorio-section-header" onclick="toggleProctorioSection('section-behavior-settings')">
                    <div class="proctorio-section-title-container">
                        <span class="proctorio-toggle-icon">▼</span>
                        <div>
                            <div class="proctorio-section-title">Proctorio Behavior Settings</div>
                            <div class="proctorio-section-subtitle">Set weights and parameters for suspect behaviour metrics.</div>
                        </div>
                    </div>
                </div>
                <div class="proctorio-section-content">
                    <input type="hidden" id="behavior-preset" value="${behaviorPreset}" />
                    
                    <!-- Presets Grid -->
                    <div style="display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 24px;">
                        <div class="proctorio-card ${behaviorPreset === 'Recommended' ? 'selected' : ''} preset-card" id="preset-recommended" onclick="selectBehaviorPreset('Recommended')" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div style="font-size: 18px; margin-bottom: 4px;">👍</div>
                            <div class="proctorio-title">Recommended</div>
                        </div>
                        <div class="proctorio-card ${behaviorPreset === 'Lenient' ? 'selected' : ''} preset-card" id="preset-lenient" onclick="selectBehaviorPreset('Lenient')" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div style="font-size: 18px; margin-bottom: 4px;">🟢</div>
                            <div class="proctorio-title">Lenient</div>
                        </div>
                        <div class="proctorio-card ${behaviorPreset === 'Moderate' ? 'selected' : ''} preset-card" id="preset-moderate" onclick="selectBehaviorPreset('Moderate')" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div style="font-size: 18px; margin-bottom: 4px;">🟡</div>
                            <div class="proctorio-title">Moderate</div>
                        </div>
                        <div class="proctorio-card ${behaviorPreset === 'Group Exam' ? 'selected' : ''} preset-card" id="preset-group-exam" onclick="selectBehaviorPreset('Group Exam')" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div style="font-size: 18px; margin-bottom: 4px;">👥</div>
                            <div class="proctorio-title">Group Exam</div>
                        </div>
                        <div class="proctorio-card ${behaviorPreset === 'Open Note' ? 'selected' : ''} preset-card" id="preset-open-note" onclick="selectBehaviorPreset('Open Note')" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div style="font-size: 18px; margin-bottom: 4px;">📝</div>
                            <div class="proctorio-title">Open Note</div>
                        </div>
                        <div class="proctorio-card ${behaviorPreset === 'Custom' ? 'selected' : ''} preset-card" id="preset-custom" onclick="selectBehaviorPreset('Custom')" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div style="font-size: 18px; margin-bottom: 4px;">🛠️</div>
                            <div class="proctorio-title">Custom</div>
                        </div>
                    </div>

                    <h4 style="margin: 0 0 12px 0; font-family:'Outfit',sans-serif; font-size:13px; font-weight:700; color:var(--text-primary);">Proctorio Frame Metrics</h4>
                    
                    <!-- Sliders / Segments list -->
                    <div id="metrics-sliders-container">
                        <!-- Navigating Away -->
                        <div class="metric-row">
                            <div class="metric-info">
                                <span style="font-size: 16px;">🌐</span>
                                <span class="metric-label-title">Navigating Away</span>
                            </div>
                            <div class="metric-bar-container">
                                <input type="hidden" id="weight-navigating-away" value="${weightNavigatingAway}" />
                                <div class="metric-segment" id="seg-navigating-away-1" onclick="updateMetricSlider('navigating-away', 1)"></div>
                                <div class="metric-segment" id="seg-navigating-away-2" onclick="updateMetricSlider('navigating-away', 2)"></div>
                                <div class="metric-segment" id="seg-navigating-away-3" onclick="updateMetricSlider('navigating-away', 3)"></div>
                                <div class="metric-segment" id="seg-navigating-away-4" onclick="updateMetricSlider('navigating-away', 4)"></div>
                                <div class="metric-segment" id="seg-navigating-away-5" onclick="updateMetricSlider('navigating-away', 5)"></div>
                            </div>
                        </div>

                        <!-- Keystrokes -->
                        <div class="metric-row">
                            <div class="metric-info">
                                <span style="font-size: 16px;">⌨️</span>
                                <span class="metric-label-title">Keystrokes</span>
                            </div>
                            <div class="metric-bar-container">
                                <input type="hidden" id="weight-keystrokes" value="${weightKeystrokes}" />
                                <div class="metric-segment" id="seg-keystrokes-1" onclick="updateMetricSlider('keystrokes', 1)"></div>
                                <div class="metric-segment" id="seg-keystrokes-2" onclick="updateMetricSlider('keystrokes', 2)"></div>
                                <div class="metric-segment" id="seg-keystrokes-3" onclick="updateMetricSlider('keystrokes', 3)"></div>
                                <div class="metric-segment" id="seg-keystrokes-4" onclick="updateMetricSlider('keystrokes', 4)"></div>
                                <div class="metric-segment" id="seg-keystrokes-5" onclick="updateMetricSlider('keystrokes', 5)"></div>
                            </div>
                        </div>

                        <!-- Copy & Paste -->
                        <div class="metric-row">
                            <div class="metric-info">
                                <span style="font-size: 16px;">📋</span>
                                <span class="metric-label-title">Copy & Paste</span>
                            </div>
                            <div class="metric-bar-container">
                                <input type="hidden" id="weight-copy-paste" value="${weightCopyPaste}" />
                                <div class="metric-segment" id="seg-copy-paste-1" onclick="updateMetricSlider('copy-paste', 1)"></div>
                                <div class="metric-segment" id="seg-copy-paste-2" onclick="updateMetricSlider('copy-paste', 2)"></div>
                                <div class="metric-segment" id="seg-copy-paste-3" onclick="updateMetricSlider('copy-paste', 3)"></div>
                                <div class="metric-segment" id="seg-copy-paste-4" onclick="updateMetricSlider('copy-paste', 4)"></div>
                                <div class="metric-segment" id="seg-copy-paste-5" onclick="updateMetricSlider('copy-paste', 5)"></div>
                            </div>
                        </div>

                        <!-- Browser Resize -->
                        <div class="metric-row">
                            <div class="metric-info">
                                <span style="font-size: 16px;">🖥️</span>
                                <span class="metric-label-title">Browser Resize</span>
                            </div>
                            <div class="metric-bar-container">
                                <input type="hidden" id="weight-browser-resize" value="${weightBrowserResize}" />
                                <div class="metric-segment" id="seg-browser-resize-1" onclick="updateMetricSlider('browser-resize', 1)"></div>
                                <div class="metric-segment" id="seg-browser-resize-2" onclick="updateMetricSlider('browser-resize', 2)"></div>
                                <div class="metric-segment" id="seg-browser-resize-3" onclick="updateMetricSlider('browser-resize', 3)"></div>
                                <div class="metric-segment" id="seg-browser-resize-4" onclick="updateMetricSlider('browser-resize', 4)"></div>
                                <div class="metric-segment" id="seg-browser-resize-5" onclick="updateMetricSlider('browser-resize', 5)"></div>
                            </div>
                        </div>

                        <!-- Head Movement -->
                        <div class="metric-row">
                            <div class="metric-info">
                                <span style="font-size: 16px;">👤</span>
                                <span class="metric-label-title">Head Movement</span>
                            </div>
                            <div class="metric-bar-container">
                                <input type="hidden" id="weight-head-movement" value="${weightHeadMovement}" />
                                <div class="metric-segment" id="seg-head-movement-1" onclick="updateMetricSlider('head-movement', 1)"></div>
                                <div class="metric-segment" id="seg-head-movement-2" onclick="updateMetricSlider('head-movement', 2)"></div>
                                <div class="metric-segment" id="seg-head-movement-3" onclick="updateMetricSlider('head-movement', 3)"></div>
                                <div class="metric-segment" id="seg-head-movement-4" onclick="updateMetricSlider('head-movement', 4)"></div>
                                <div class="metric-segment" id="seg-head-movement-5" onclick="updateMetricSlider('head-movement', 5)"></div>
                            </div>
                        </div>

                        <!-- Multi-Face -->
                        <div class="metric-row">
                            <div class="metric-info">
                                <span style="font-size: 16px;">👥</span>
                                <span class="metric-label-title">Multi-Face</span>
                            </div>
                            <div class="metric-bar-container">
                                <input type="hidden" id="weight-multi-face" value="${weightMultiFace}" />
                                <div class="metric-segment" id="seg-multi-face-1" onclick="updateMetricSlider('multi-face', 1)"></div>
                                <div class="metric-segment" id="seg-multi-face-2" onclick="updateMetricSlider('multi-face', 2)"></div>
                                <div class="metric-segment" id="seg-multi-face-3" onclick="updateMetricSlider('multi-face', 3)"></div>
                                <div class="metric-segment" id="seg-multi-face-4" onclick="updateMetricSlider('multi-face', 4)"></div>
                                <div class="metric-segment" id="seg-multi-face-5" onclick="updateMetricSlider('multi-face', 5)"></div>
                            </div>
                        </div>

                        <!-- Leaving the Room -->
                        <div class="metric-row">
                            <div class="metric-info">
                                <span style="font-size: 16px;">🚪</span>
                                <span class="metric-label-title">Leaving the Room</span>
                            </div>
                            <div class="metric-bar-container">
                                <input type="hidden" id="weight-leaving-room" value="${weightLeavingRoom}" />
                                <div class="metric-segment" id="seg-leaving-room-1" onclick="updateMetricSlider('leaving-room', 1)"></div>
                                <div class="metric-segment" id="seg-leaving-room-2" onclick="updateMetricSlider('leaving-room', 2)"></div>
                                <div class="metric-segment" id="seg-leaving-room-3" onclick="updateMetricSlider('leaving-room', 3)"></div>
                                <div class="metric-segment" id="seg-leaving-room-4" onclick="updateMetricSlider('leaving-room', 4)"></div>
                                <div class="metric-segment" id="seg-leaving-room-5" onclick="updateMetricSlider('leaving-room', 5)"></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Accordion Section 3: Proctorio Exam Metrics -->
            <div class="proctorio-section collapsed" id="section-exam-metrics">
                <div class="proctorio-section-header" onclick="toggleProctorioSection('section-exam-metrics')">
                    <div class="proctorio-section-title-container">
                        <span class="proctorio-toggle-icon">▼</span>
                        <div>
                            <div class="proctorio-section-title">Proctorio Exam Metrics</div>
                            <div class="proctorio-section-subtitle">Enable system flags for tracking candidate abnormal behavior.</div>
                        </div>
                    </div>
                </div>
                <div class="proctorio-section-content">
                    <h4 style="margin: 0 0 6px 0; font-family:'Outfit',sans-serif; font-size:13px; font-weight:700; color:var(--text-primary);">Computer Based Abnormalities</h4>
                    <div class="proctorio-grid" style="grid-template-columns: repeat(5, 1fr); margin-bottom: 20px;">
                        <div class="proctorio-card selected" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div class="proctorio-title">Navigating Away</div>
                        </div>
                        <div class="proctorio-card selected" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div class="proctorio-title">Keystrokes</div>
                        </div>
                        <div class="proctorio-card selected" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div class="proctorio-title">Copy & Paste</div>
                        </div>
                        <div class="proctorio-card selected" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div class="proctorio-title">Browser Resize</div>
                        </div>
                        <div class="proctorio-card selected" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div class="proctorio-title">Mouse Movement</div>
                        </div>
                    </div>

                    <h4 style="margin: 0 0 6px 0; font-family:'Outfit',sans-serif; font-size:13px; font-weight:700; color:var(--text-primary);">Environmental Abnormalities</h4>
                    <div class="proctorio-grid" style="grid-template-columns: repeat(5, 1fr); margin-bottom: 20px;">
                        <div class="proctorio-card selected" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div class="proctorio-title">Head Movement</div>
                        </div>
                        <div class="proctorio-card selected" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div class="proctorio-title">Leaving the Room</div>
                        </div>
                        <div class="proctorio-card selected" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div class="proctorio-title">Multi-Face</div>
                        </div>
                    </div>

                    <h4 style="margin: 0 0 6px 0; font-family:'Outfit',sans-serif; font-size:13px; font-weight:700; color:var(--text-primary);">Technical Abnormalities</h4>
                    <div class="proctorio-grid" style="grid-template-columns: repeat(5, 1fr);">
                        <div class="proctorio-card selected" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div class="proctorio-title">Exam Duration</div>
                        </div>
                        <div class="proctorio-card selected" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div class="proctorio-title">Start Times</div>
                        </div>
                        <div class="proctorio-card selected" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div class="proctorio-title">End Times</div>
                        </div>
                        <div class="proctorio-card selected" style="aspect-ratio: auto; padding: 12px 6px;">
                            <div class="proctorio-title">Exam Collusion</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Accordion Section 4: Advanced Integrations & Custom Instructions -->
            <div class="proctorio-section collapsed" id="section-advanced">
                <div class="proctorio-section-header" onclick="toggleProctorioSection('section-advanced')">
                    <div class="proctorio-section-title-container">
                        <span class="proctorio-toggle-icon">▼</span>
                        <div>
                            <div class="proctorio-section-title">Advanced Integrations & Custom Instructions</div>
                            <div class="proctorio-section-subtitle">Configure Safe Exam Browser, companion apps, and candidate instructions.</div>
                        </div>
                    </div>
                </div>
                <div class="proctorio-section-content">
                    <!-- Safe Exam Browser -->
                    <div style="margin-top: 10px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
                        <div style="display: flex; align-items: center; justify-content: space-between;">
                            <div>
                                <h4 style="font-family:'Outfit',sans-serif; font-size:14px; font-weight:700; color:var(--text-primary); margin:0; display:flex; align-items:center; gap:6px;"><img src="icons/block-navigation.svg" style="width: 16px; height: 16px;" /> Require Safe Exam Browser (SEB)</h4>
                                <p style="font-size:11px; color:var(--text-muted); margin: 2px 0 0 0;">Forces students to launch and complete the quiz inside SEB</p>
                            </div>
                            <div>
                                <label class="switch-container" style="position: relative; display: inline-block; width: 44px; height: 24px; cursor: pointer;">
                                    <input type="checkbox" id="chk-seb" ${exam && exam.require_seb ? 'checked' : ''} onchange="toggleSebSection()" style="opacity: 0; width: 0; height: 0;" />
                                    <span class="switch-slider" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background-color: ${exam && exam.require_seb ? '#008ee2' : '#cbd5e1'}; transition: .3s; border-radius: 24px;"></span>
                                </label>
                            </div>
                        </div>
                        
                        <div id="seb-options-container" style="display: ${exam && exam.require_seb ? 'block' : 'none'}; margin-top: 16px; border-top: 1px solid #cbd5e1; padding-top: 12px;">
                            <div class="proctorio-grid">
                                <div class="proctorio-card ${exam && exam.block_downloads ? 'selected' : ''}" id="card-downloads-seb" onclick="toggleProctorioOption('chk-downloads', 'card-downloads-seb')" title="Block file downloading">
                                    <div class="proctorio-icon"><img src="icons/block-downloads.svg" alt="" /></div>
                                    <div class="proctorio-title">Block Downloads</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Chrome Extension Toggle -->
                    <div style="margin-top: 10px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
                        <div style="display: flex; align-items: center; justify-content: space-between;">
                            <div>
                                <h4 style="font-family:'Outfit',sans-serif; font-size:14px; font-weight:700; color:var(--text-primary); margin:0; display:flex; align-items:center; gap:6px;"><img src="icons/disable-extensions.svg" style="width: 16px; height: 16px;" /> Require Secure Chrome Extension</h4>
                                <p style="font-size:11px; color:var(--text-muted); margin: 2px 0 0 0;">Enables advanced browser lockdown and web traffic analysis</p>
                            </div>
                            <div>
                                <label class="switch-container" style="position: relative; display: inline-block; width: 44px; height: 24px; cursor: pointer;">
                                    <input type="checkbox" id="chk-extension" ${!exam || exam.require_extension ? 'checked' : ''} onchange="toggleExtensionSection()" style="opacity: 0; width: 0; height: 0;" />
                                    <span class="switch-slider" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background-color: ${!exam || exam.require_extension ? '#008ee2' : '#cbd5e1'}; transition: .3s; border-radius: 24px;"></span>
                                </label>
                            </div>
                        </div>
                        <div id="extension-options-container" style="display: ${!exam || exam.require_extension ? 'block' : 'none'}; margin-top: 16px; border-top: 1px solid #cbd5e1; padding-top: 12px;">
                            <div class="proctorio-grid">
                                <div class="proctorio-card ${exam && exam.disable_extensions ? 'selected' : ''}" id="card-ext-extensions" onclick="toggleProctorioOption('chk-ext-extensions', 'card-ext-extensions')" title="Disable all other Chrome extensions">
                                    <div class="proctorio-icon"><img src="icons/disable-extensions.svg" alt="" /></div>
                                    <div class="proctorio-title">Disable Extensions</div>
                                    <input type="checkbox" id="chk-ext-extensions" ${exam && exam.disable_extensions ? 'checked' : ''} style="display:none;" />
                                </div>
                                <div class="proctorio-card ${exam && exam.prevent_incognito ? 'selected' : ''}" id="card-ext-incognito" onclick="toggleProctorioOption('chk-ext-incognito', 'card-ext-incognito')" title="Block exam access in Incognito mode">
                                    <div class="proctorio-icon"><img src="icons/prevent-incognito.svg" alt="" /></div>
                                    <div class="proctorio-title">Prevent Incognito</div>
                                    <input type="checkbox" id="chk-ext-incognito" ${exam && exam.prevent_incognito ? 'checked' : ''} style="display:none;" />
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Desktop Companion App -->
                    <div style="margin-top: 10px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
                        <div style="display: flex; align-items: center; justify-content: space-between;">
                            <div>
                                <h4 style="font-family:'Outfit',sans-serif; font-size:14px; font-weight:700; color:var(--text-primary); margin:0; display:flex; align-items:center; gap:6px;"><img src="icons/record-screen.svg" style="width: 16px; height: 16px;" /> Require Secure Desktop Companion App</h4>
                                <p style="font-size:11px; color:var(--text-muted); margin: 2px 0 0 0;">Lock down background applications, secondary screens, and check VM setups</p>
                            </div>
                            <div>
                                <label class="switch-container" style="position: relative; display: inline-block; width: 44px; height: 24px; cursor: pointer;">
                                    <input type="checkbox" id="chk-companion" ${exam && exam.require_companion_app ? 'checked' : ''} onchange="toggleCompanionSection()" style="opacity: 0; width: 0; height: 0;" />
                                    <span class="switch-slider" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background-color: ${exam && exam.require_companion_app ? '#008ee2' : '#cbd5e1'}; transition: .3s; border-radius: 24px;"></span>
                                </label>
                            </div>
                        </div>
                        
                        <div id="companion-options-container" style="display: ${exam && exam.require_companion_app ? 'block' : 'none'}; margin-top: 16px; border-top: 1px solid #cbd5e1; padding-top: 12px;">
                            <div style="display: flex; gap: 16px; margin-bottom: 12px;">
                                <div style="flex: 1;">
                                    <label class="form-label" style="font-size:12px; font-weight:600; color:var(--text-primary); display:block; margin-bottom:4px;">Allowed Apps (Comma separated)</label>
                                    <input type="text" id="allowed-apps" class="form-input" style="width:100%;" placeholder="e.g. calc, winword" value="${exam && exam.allowed_apps ? exam.allowed_apps : ''}" />
                                </div>
                                <div style="flex: 1;">
                                    <label class="form-label" style="font-size:12px; font-weight:600; color:var(--text-primary); display:block; margin-bottom:4px;">Blocked Apps (Comma separated)</label>
                                    <input type="text" id="blocked-apps" class="form-input" style="width:100%;" placeholder="e.g. discord, zoom" value="${exam && exam.blocked_apps ? exam.blocked_apps : ''}" />
                                </div>
                            </div>
                            <div class="form-group" style="margin-top: 12px;">
                                <label class="form-label" style="font-size:12px; font-weight:600; color:var(--text-primary); display:block; margin-bottom:4px;">Allowed Websites (inside Companion App)</label>
                                <textarea id="allowed-urls" class="form-input" style="height: 80px; font-family: monospace; width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; background: var(--bg-primary); color: var(--text-primary); resize: vertical;" placeholder="https://www.google.com&#10;https://wikipedia.org">${exam && exam.allowed_urls ? exam.allowed_urls : ''}</textarea>
                                <div class="form-hint" style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">List full URLs or domains allowed inside the companion app browser (one per line).</div>
                            </div>
                        </div>
                    </div>

                    <!-- Custom Instructions -->
                    <div style="margin-top: 10px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
                        <h4 style="font-family:'Outfit',sans-serif; font-size:14px; font-weight:700; color:var(--text-primary); margin:0;">📝 Custom Instructions (Optional)</h4>
                        <p style="font-size:11px; color:var(--text-muted); margin: 2px 0 10px 0;">Add custom instructions for students to read before starting the quiz.</p>
                        <textarea id="additional-instructions" class="form-input" style="height: 80px; width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; background: var(--bg-primary); color: var(--text-primary); resize: vertical;" placeholder="e.g. You are allowed to use one blank sheet of scratch paper.">${exam && exam.additional_instructions ? exam.additional_instructions : ''}</textarea>
                    </div>
                </div>
            </div>
        </div>

        <div style="margin-top: 32px; text-align: right; border-top: 1px solid var(--border); padding-top: 15px;">
            <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="saveExam(${examId})">${exam ? 'Save Changes' : 'Enable Proctoring'}</button>
        </div>
    `;

    // Toggle logic functions exposed to window
    window.toggleProctorioSection = function(sectionId) {
        const el = document.getElementById(sectionId);
        if (el) {
            el.classList.toggle('collapsed');
        }
    };

    window.selectBehaviorPreset = function(presetName) {
        document.querySelectorAll('.preset-card').forEach(c => c.classList.remove('selected'));
        const selectedCard = document.getElementById('preset-' + presetName.toLowerCase().replace(/\s+/g, '-'));
        if (selectedCard) {
            selectedCard.classList.add('selected');
        }
        
        document.getElementById('behavior-preset').value = presetName;
        
        const presets = {
            'Recommended': { away: 3, key: 1, copy: 4, resize: 2, head: 2, face: 3, room: 3 },
            'Lenient': { away: 1, key: 0, copy: 1, resize: 0, head: 0, face: 1, room: 1 },
            'Moderate': { away: 2, key: 1, copy: 2, resize: 1, head: 1, face: 2, room: 2 },
            'Group Exam': { away: 1, key: 1, copy: 2, resize: 1, head: 0, face: 0, room: 0 },
            'Open Note': { away: 0, key: 0, copy: 0, resize: 0, head: 0, face: 0, room: 0 },
            'Custom': null
        };
        
        const w = presets[presetName];
        if (w) {
            updateMetricSlider('navigating-away', w.away, false);
            updateMetricSlider('keystrokes', w.key, false);
            updateMetricSlider('copy-paste', w.copy, false);
            updateMetricSlider('browser-resize', w.resize, false);
            updateMetricSlider('head-movement', w.head, false);
            updateMetricSlider('multi-face', w.face, false);
            updateMetricSlider('leaving-room', w.room, false);
        }
    };

    window.updateMetricSlider = function(metricId, val, triggerCustom = true) {
        // If they click on a segment, automatically set to Custom preset if it isn't already Custom
        const presetInput = document.getElementById('behavior-preset');
        if (triggerCustom && presetInput && presetInput.value !== 'Custom') {
            document.querySelectorAll('.preset-card').forEach(c => c.classList.remove('selected'));
            const customCard = document.getElementById('preset-custom');
            if (customCard) customCard.classList.add('selected');
            presetInput.value = 'Custom';
        }

        const input = document.getElementById('weight-' + metricId);
        if (input) {
            input.value = val;
        }
        
        for (let i = 1; i <= 5; i++) {
            const seg = document.getElementById('seg-' + metricId + '-' + i);
            if (!seg) continue;
            
            seg.className = 'metric-segment';
            if (i <= val) {
                if (val <= 2) {
                    seg.classList.add('active-green');
                } else if (val === 3) {
                    seg.classList.add('active-orange');
                } else {
                    seg.classList.add('active-red');
                }
            }
        }
    };

    window.toggleExtensionSection = function() {
        const chk = document.getElementById('chk-extension');
        const slider = chk.nextElementSibling;
        const container = document.getElementById('extension-options-container');
        if (chk && container) {
            container.style.display = chk.checked ? 'block' : 'none';
            slider.style.backgroundColor = chk.checked ? '#008ee2' : '#cbd5e1';
        }
    };

    window.toggleSebSection = function() {
        const chk = document.getElementById('chk-seb');
        const slider = chk.nextElementSibling;
        const container = document.getElementById('seb-options-container');
        if (chk && container) {
            container.style.display = chk.checked ? 'block' : 'none';
            slider.style.backgroundColor = chk.checked ? '#008ee2' : '#cbd5e1';
        }
    };

    window.toggleCompanionSection = function() {
        const chk = document.getElementById('chk-companion');
        const slider = chk.nextElementSibling;
        const container = document.getElementById('companion-options-container');
        if (chk && container) {
            container.style.display = chk.checked ? 'block' : 'none';
            slider.style.backgroundColor = chk.checked ? '#008ee2' : '#cbd5e1';
        }
    };

    document.getElementById('modal-content').innerHTML = html;
    
    // Initialize metric segments visually
    setTimeout(() => {
        updateMetricSlider('navigating-away', weightNavigatingAway, false);
        updateMetricSlider('keystrokes', weightKeystrokes, false);
        updateMetricSlider('copy-paste', weightCopyPaste, false);
        updateMetricSlider('browser-resize', weightBrowserResize, false);
        updateMetricSlider('head-movement', weightHeadMovement, false);
        updateMetricSlider('multi-face', weightMultiFace, false);
        updateMetricSlider('leaving-room', weightLeavingRoom, false);
    }, 50);

    document.getElementById('modal-overlay').classList.add('active');
}
 
function toggleProctorioOption(checkboxId, cardId) {
    const chk = document.getElementById(checkboxId);
    const card = document.getElementById(cardId);
    if (chk && card) {
        chk.checked = !chk.checked;
        if (chk.checked) {
            card.classList.add('selected');
        } else {
            card.classList.remove('selected');
        }
    }
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
        require_seb: document.getElementById('chk-seb').checked,
        disable_clipboard: document.getElementById('chk-clipboard').checked,
        disable_printing: document.getElementById('chk-printing').checked,
        only_one_screen: document.getElementById('chk-one-screen').checked,
        block_downloads: document.getElementById('chk-downloads').checked,
        prevent_reentry: document.getElementById('chk-reentry').checked,
        require_room_scan: document.getElementById('chk-room-scan').checked,
        require_mobile_camera: false,
        require_extension: document.getElementById('chk-extension').checked,
        record_web_traffic: document.getElementById('chk-ext-traffic') ? document.getElementById('chk-ext-traffic').checked : false,
        disable_new_tabs: document.getElementById('chk-ext-newtabs') ? document.getElementById('chk-ext-newtabs').checked : false,
        close_open_tabs: document.getElementById('chk-ext-closetabs') ? document.getElementById('chk-ext-closetabs').checked : false,
        disable_extensions: document.getElementById('chk-ext-extensions') ? document.getElementById('chk-ext-extensions').checked : false,
        prevent_incognito: document.getElementById('chk-ext-incognito') ? document.getElementById('chk-ext-incognito').checked : false,
        clear_cache: document.getElementById('chk-ext-cache') ? document.getElementById('chk-ext-cache').checked : false,
        require_companion_app: document.getElementById('chk-companion').checked,
        allowed_apps: document.getElementById('allowed-apps') ? document.getElementById('allowed-apps').value.trim() : null,
        blocked_apps: document.getElementById('blocked-apps') ? document.getElementById('blocked-apps').value.trim() : null,
        allowed_urls: document.getElementById('allowed-urls') ? document.getElementById('allowed-urls').value.trim() : '',
        additional_instructions: document.getElementById('additional-instructions') ? document.getElementById('additional-instructions').value.trim() : '',
        
        // Proctorio makeover specific parameters
        verify_video: document.getElementById('chk-verify-video') ? document.getElementById('chk-verify-video').checked : false,
        verify_audio: document.getElementById('chk-verify-audio') ? document.getElementById('chk-verify-audio').checked : false,
        verify_desktop: document.getElementById('chk-verify-desktop') ? document.getElementById('chk-verify-desktop').checked : false,
        verify_id: document.getElementById('chk-verify-id') ? document.getElementById('chk-verify-id').checked : false,
        verify_signature: document.getElementById('chk-verify-signature') ? document.getElementById('chk-verify-signature').checked : false,
        allow_calculator: document.getElementById('chk-allow-calculator') ? document.getElementById('chk-allow-calculator').checked : false,
        allow_whiteboard: document.getElementById('chk-allow-whiteboard') ? document.getElementById('chk-allow-whiteboard').checked : false,
        behavior_preset: document.getElementById('behavior-preset') ? document.getElementById('behavior-preset').value : 'Recommended',
        weight_navigating_away: parseInt(document.getElementById('weight-navigating-away') ? document.getElementById('weight-navigating-away').value : 3),
        weight_keystrokes: parseInt(document.getElementById('weight-keystrokes') ? document.getElementById('weight-keystrokes').value : 1),
        weight_copy_paste: parseInt(document.getElementById('weight-copy-paste') ? document.getElementById('weight-copy-paste').value : 4),
        weight_browser_resize: parseInt(document.getElementById('weight-browser-resize') ? document.getElementById('weight-browser-resize').value : 2),
        weight_head_movement: parseInt(document.getElementById('weight-head-movement') ? document.getElementById('weight-head-movement').value : 2),
        weight_multi_face: parseInt(document.getElementById('weight-multi-face') ? document.getElementById('weight-multi-face').value : 3),
        weight_leaving_room: parseInt(document.getElementById('weight-leaving-room') ? document.getElementById('weight-leaving-room').value : 3)
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
    // Reset inline styles that may have been set by the immersive report view
    const mc = document.getElementById('modal-content');
    if (mc) {
        mc.style.padding = '';
        mc.style.background = '';
        mc.style.border = '';
        mc.style.borderRadius = '';
        mc.style.display = '';
        mc.style.flexDirection = '';
        mc.style.height = '';
        mc.style.overflow = '';
        mc.style.maxWidth = '';
        mc.style.width = '';
    }
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
                const examTitle = exam ? exam.title : 'ProctorGuard Assignment';
                const launchUrl = window.location.origin + '/lti/launch';
                window.location.href = `/api/placements/lti-return?content_item_return_url=${encodeURIComponent(contentItemReturnUrl)}&exam_title=${encodeURIComponent(examTitle)}&launch_url=${encodeURIComponent(launchUrl)}`;
            } else if (launchReturnUrl) {
                const exam = exams.find(e => e.id == examId);
                const examTitle = exam ? exam.title : 'ProctorGuard Assignment';
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
    const examTitle = exam ? exam.title : 'ProctorGuard Assignment';
    // Embed the exam_id in the launch URL returned to Canvas
    const launchUrl = `${window.location.origin}/lti/launch?exam_id=${examId}`;
    let targetUrl = `/api/placements/lti-return?content_item_return_url=${encodeURIComponent(contentItemReturnUrl)}&exam_title=${encodeURIComponent(examTitle)}&launch_url=${encodeURIComponent(launchUrl)}`;
    if (ltiData) {
        targetUrl += `&lti_data=${encodeURIComponent(ltiData)}`;
    }
    window.location.href = targetUrl;
}
