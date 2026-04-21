let exams = [];
let liveStudents = {}; 
let currentLiveExamId = null;
let currentFullscreenSessionId = null;
let socket = io();

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
});

document.addEventListener('DOMContentLoaded', () => {
    checkDatabaseCapacity();
    loadExams(); // Boot directly into Exams Workspace
});

async function checkDatabaseCapacity() {
    try {
        const res = await fetch('/api/db-status');
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

async function loadExams() {
    const res = await fetch('/api/exams');
    exams = await res.json();
    renderExams();
}

function renderExams() {
    const content = document.getElementById('content');
    let html = `
        <div class="page-header">
            <div>
                <h1 class="page-title">Configured Exams</h1>
                <p class="page-subtitle">Select an exam below to enter its workspace, monitor live students, and view final reports.</p>
            </div>
            <button class="btn btn-primary" onclick="showCreateExamModal()">+ New Proctored Exam</button>
        </div>
        <div class="session-grid">
    `;

    if (exams.length === 0) {
        html += `
            <div class="empty-state" style="grid-column: 1/-1;">
                <div class="empty-icon">📝</div>
                <div class="empty-text">No Exams configured yet</div>
                <div class="empty-hint">Click the button above to link a Canvas Quiz.</div>
            </div>
        `;
    } else {
        exams.forEach(ex => {
            html += `
                <div class="card session-card" style="position:relative; cursor:pointer;" onclick="loadExamDashboard(${ex.id})">
                    <button class="btn" style="position:absolute; top: 15px; right: 15px; background: var(--danger); color: white; padding: 4px 8px; font-size: 12px; border:none; border-radius: 4px;" onclick="event.stopPropagation(); deleteExam(${ex.id})">Delete</button>
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom: 4px;">
                        <div class="session-date">${new Date(ex.created_at).toLocaleDateString()}</div>
                        <span style="font-size:10px; padding: 2px 6px; border-radius: 10px; font-weight:bold; text-transform:uppercase; ${ex.is_open ? 'background:var(--success-bg); color:var(--success);' : 'background:var(--danger-bg); color:var(--danger);'}">
                            ${ex.is_open ? '● Open' : '● Closed'}
                        </span>
                    </div>
                    <div class="session-title">${ex.title}</div>
                    <div style="margin-top: 10px; font-weight: bold; font-size: 14px; background: #eef2ff; color: #4338ca; padding: 5px 10px; border-radius: 4px; display: inline-block;">Code: ${ex.exam_code}</div>
                    <div style="font-size: 12px; color: var(--text-secondary); margin-top: 8px;">
                        <div>Max Attempts: ${ex.max_attempts || 1}</div>
                        <div>📷 Camera: ${ex.require_camera ? 'Yes' : 'No'} | 🎤 Mic: ${ex.require_mic ? 'Yes' : 'No'} | 💻 Screen: ${ex.require_screen ? 'Yes' : 'No'} | 🛡️ SEB: ${ex.require_seb ? 'Yes' : 'No'}</div>
                    </div>
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
                <button class="btn btn-secondary" style="margin-bottom: 10px;" onclick="closeExamDashboard()">← Back to Exams</button>
                <div style="display:flex; align-items:center; gap: 15px;">
                    <h1 class="page-title">${exam.title} Workspace</h1>
                    <button class="btn" id="status-toggle-btn" 
                        style="padding: 6px 14px; font-size: 13px; border-radius: 20px; font-weight: bold; border: none; cursor: pointer; transition: var(--transition);
                        ${exam.is_open ? 'background:var(--success); color:white;' : 'background:var(--danger); color:white;'}"
                        onclick="toggleExamStatus(${exam.id})">
                        ${exam.is_open ? '🔓 Exam is OPEN' : '🔒 Exam is CLOSED'}
                    </button>
                </div>
                <p class="page-subtitle">Now Managing Exam Code: <strong style="color:var(--primary)">${exam.exam_code}</strong></p>
            </div>
        </div>
        
        <!-- Grid layout cleanly splitting Live Monitor & Reports side-by-side or stacked -->
        <div style="display: flex; flex-direction: column; gap: 30px; margin-top: 20px;">
            <!-- Live Monitoring Block -->
            <div class="card" style="padding: 20px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 15px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px;">
                    <h2 style="font-size: 18px; font-weight: 600;">Live Monitoring Feed</h2>
                    <span style="font-size:12px; color:var(--text-secondary);">Click on a student's webcam to expand securely. Updates dynamically.</span>
                </div>
                <div id="live-grid" class="session-grid"></div>
            </div>
            
            <!-- Reports Block -->
            <div class="card" style="padding: 20px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 15px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px;">
                    <h2 style="font-size: 18px; font-weight: 600;">Post-Exam Reports & Video Vault</h2>
                    <div style="display:flex; gap: 8px;">
                        <button class="btn btn-primary" style="font-size:12px; padding: 4px 8px; background:var(--accent); color:white !important; border:none;" onclick="window.open('/api/exams/${exam.id}/export-videos', '_blank')">📁 Download .ZIP Archive</button>
                        <button class="btn btn-secondary" style="font-size:12px; padding: 4px 8px; background:var(--danger); color:white !important; border:none;" onclick="purgeVideosOnly(${exam.id})">🗑️ Purge Video Engine</button>
                        <button class="btn btn-secondary" style="font-size:12px; padding: 4px 8px;" onclick="fetchReportData(${exam.id})">Refresh Reports</button>
                    </div>
                </div>
                <div id="report-content"><div class="spinner" style="margin: 20px auto;"></div></div>
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
            content = `<img src="${s.screenshot}" style="width:100%; height:120px; object-fit:cover; border-radius: 4px; cursor: pointer;" onclick="openFullscreenImg('${s.screenshot}', ${sessionId})" />`;
        } else {
            content = `<div style="width:100%; height:120px; background:#ddd; border-radius: 4px; display:flex; align-items:center; justify-content:center; color:#888;">No Signal</div>`;
        }

        grid.innerHTML += `
            <div class="card" style="padding: 12px; background: #f8fafc;">
                <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <strong style="font-size: 14px;">${s.name || 'Testing...'}</strong>
                    <span style="width: 10px; height: 10px; background: ${statusColor}; border-radius: 50%; display:inline-block;"></span>
                </div>
                ${content}
            </div>
        `;
    });

    if(Object.keys(liveStudents).length === 0) {
        grid.innerHTML = '<div style="color: var(--text-muted); font-size: 14px; grid-column:1/-1; padding:20px 0;">Live queue is currently empty. Waiting for students to authenticate...</div>';
    }
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

// REPORTS LOGIC
async function fetchReportData(examId) {
    if(!examId) return;
    const tableContainer = document.getElementById('report-content');
    if(!tableContainer) return;

    try {
        const res = await fetch(`/api/exams/${examId}/reports`);
        const sessions = await res.json();
        
        if (sessions.error) {
            tableContainer.innerHTML = `<div style="padding: 20px; color: var(--danger); text-align:center;">Error loading reports: ${sessions.error}</div>`;
            return;
        }

        if(!Array.isArray(sessions)) {
             tableContainer.innerHTML = `<div style="padding: 20px; color: var(--danger); text-align:center;">Unexpected data format from server.</div>`;
             return;
        }

        let tableHtml = `
            <div class="table-wrapper">
            <table style="width:100%">
                <thead>
                    <tr>
                        <th>Student Name</th>
                        <th>Status</th>
                        <th>Started At</th>
                        <th>Security Flags / Event Timeline</th>
                        <th>Recorded Video Playback</th>
                    </tr>
                </thead>
                <tbody>
        `;

        sessions.forEach(s => {
            let logsList = `<ul>`;
            const logs = Array.isArray(s.logs) ? s.logs : [];
            logs.forEach(l => {
                logsList += `<li><strong style="color:var(--danger)">${l.event_type}</strong>: <span style="font-size:12px;">${l.event_message}</span> <span style="color:#888;font-size:11px;">(${new Date(l.event_timestamp).toLocaleTimeString()})</span></li>`;
            });
            if(logs.length === 0) logsList += "<li style='color:var(--success); font-weight:bold;'>No flags recorded. Clean run!</li>";
            logsList += '</ul>';

            tableHtml += `
                <tr>
                    <td style="font-weight: 600;">
                        ${s.student_name || s.student_canvas_id} 
                        <div style="font-size: 11px; color:#666;">(Attempt ${s.attempt_number || 1})</div>
                        <button class="btn btn-secondary" style="display:block; margin-top:8px; font-size:11px; padding:4px 8px; border: 1px solid var(--border-color); background: white;" onclick="grantExtraAttempt(${s.exam_id}, '${s.student_canvas_id}')">+1 Override Pass</button>
                    </td>
                    <td><span class="status-badge status-${s.status === 'completed' ? 'Present' : 'Late'}">${s.status}</span></td>
                    <td>${new Date(s.started_at).toLocaleString()}</td>
                    <td style="font-size: 13px;">${logsList}</td>
                    <td>
                        ${s.status === 'completed' && !s.video_archived ? `<a href="/watch.html?session=${s.id}" target="_blank" class="btn btn-primary" style="font-size:12px; padding:8px 12px; border-radius: 4px; background:#4338ca; color:white; text-decoration:none; display:inline-block;">Watch Final Video</a>` 
                        : (s.video_archived ? '<span style="color:var(--danger); font-size:12px; font-weight:bold;">[Archived Off-Site]</span>' : '<span style="color:#888; font-style:italic; font-size:12px;">In Progress...</span>')}
                    </td>
                </tr>
            `;
        });

        if (sessions.length === 0) {
            tableHtml += '<tr><td colspan="5" style="text-align:center; padding: 20px; color:#888;">No recorded attempts in the vault yet.</td></tr>';
        }

        tableHtml += '</tbody></table></div>';
        tableContainer.innerHTML = tableHtml;
    } catch (err) {
        console.error("Report fetch failed", err);
        tableContainer.innerHTML = `<div style="padding: 20px; color: var(--danger); text-align:center;">Connection Error. Check console for details.</div>`;
    }
}

// EXAM GENERATION & DELETION MODALS
function showCreateExamModal() {
    const defaultCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const html = `
        <div class="modal-header">
            <h2 class="modal-title">Link Canvas Quiz</h2>
            <button class="modal-close" onclick="closeModal()">×</button>
        </div>
        <div class="form-group">
            <label class="form-label">Exam Title</label>
            <input type="text" id="exam-title" class="form-input" placeholder="e.g. Midterm Physics">
        </div>
        <div class="form-group" style="display: flex; gap: 10px;">
            <div style="flex:1;">
                <label class="form-label">Access Code</label>
                <input type="text" id="exam-code" class="form-input" value="${defaultCode}">
            </div>
            <div style="flex:1;">
                <label class="form-label">Max Attempts</label>
                <input type="number" id="max-attempts" class="form-input" value="1" min="1">
            </div>
        </div>
        <div class="form-group">
            <label class="form-label">Canvas Quiz URL</label>
            <input type="text" id="exam-url" class="form-input" placeholder="https://canvas.instructure.com/courses/1/quizzes/1">
            <div class="form-hint">Paste the URL of the Canvas Quiz. Do NOT share this URL directly with students.</div>
        </div>
        <div style="margin-top: 20px;">
            <label class="form-check" style="margin-bottom: 8px;">
                <input type="checkbox" id="chk-camera" checked> Require Web Camera
            </label>
            <label class="form-check" style="margin-bottom: 8px;">
                <input type="checkbox" id="chk-mic" checked> Require Microphone
            </label>
            <label class="form-check" style="margin-bottom: 8px;">
                <input type="checkbox" id="chk-screen" checked> Require Screen Sharing (Entire Screen)
            </label>
            <label class="form-check" style="margin-bottom: 8px;">
                <input type="checkbox" id="chk-rc" checked> Disable Right Click / Tab Switches
            </label>
            <label class="form-check" style="margin-bottom: 8px;">
                <input type="checkbox" id="chk-fs" checked> Enforce Fullscreen Mode
            </label>
            <label class="form-check">
                <input type="checkbox" id="chk-seb"> Require Safe Exam Browser
            </label>
        </div>
        <div style="margin-top: 24px; text-align: right;">
            <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="saveExam()">Create</button>
        </div>
    `;
    
    document.getElementById('modal-content').innerHTML = html;
    document.getElementById('modal-overlay').classList.add('active');
}

async function saveExam() {
    const payload = {
        title: document.getElementById('exam-title').value,
        canvas_quiz_url: document.getElementById('exam-url').value,
        exam_code: document.getElementById('exam-code').value,
        max_attempts: parseInt(document.getElementById('max-attempts').value) || 1,
        require_camera: document.getElementById('chk-camera').checked,
        require_mic: document.getElementById('chk-mic').checked,
        require_screen: document.getElementById('chk-screen').checked,
        disable_right_click: document.getElementById('chk-rc').checked,
        require_fullscreen: document.getElementById('chk-fs').checked,
        require_seb: document.getElementById('chk-seb').checked
    };

    if(!payload.title || !payload.canvas_quiz_url) return alert('Fill all fields');

    try {
        const res = await fetch('/api/exams', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if(res.ok) {
            closeModal();
            loadExams();
            showToast('Exam configured securely!', 'success');
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
        const res = await fetch(`/api/exams/${id}/status`, {
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
            await fetch('/api/exams/' + id, {method: 'DELETE'});
            loadExams();
            showToast('Exam completely deleted.', 'success');
        } catch(e) {
            console.error(e);
        }
    }
}

async function purgeVideosOnly(id) {
    if(confirm('WARNING: Are you absolutely sure you want to hard purge all video footage from the database? This is permanent. Please ensure you have downloaded the ZIP Archive first! The security reports will be safely kept.')) {
        try {
            await fetch('/api/exams/' + id + '/videos-only', {method: 'DELETE'});
            fetchReportData(id); // Refresh securely inside details view!
            showToast('Video footage hard purged. Database space reclaimed.', 'success');
        } catch(e) {
            console.error(e);
        }
    }
}

async function grantExtraAttempt(examId, studentCanvasId) {
    if(!confirm("Are you sure you want to grant this specific student an additional attempt?")) return;
    try {
        await fetch('/api/exams/' + examId + '/overrides', {
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
