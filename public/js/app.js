let exams = [];
let liveStudents = {}; 
let currentLiveExamId = null;
let socket = io();

socket.on('snapshot_update', (data) => {
    // data: { exam_id, exam_session_id, student_canvas_id, screenshot_data_url }
    if(currentLiveExamId == data.exam_id) {
        liveStudents[data.exam_session_id] = { ...liveStudents[data.exam_session_id], screenshot: data.screenshot_data_url };
        updateLiveGrid();
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
    navigate('exams');
});

function navigate(page) {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const navItem = document.querySelector(`[data-page="${page}"]`);
    if(navItem) navItem.classList.add('active');

    document.getElementById('content').innerHTML = '<div class="spinner" style="margin: 40px auto;"></div>';

    if (page === 'exams') loadExams();
    if (page === 'live') loadLiveExamSelect();
    if (page === 'reports') loadReports();
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
                <p class="page-subtitle">Setup proctoring for your Canvas Quizzes.</p>
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
                <div class="card session-card">
                    <div class="session-date">${new Date(ex.created_at).toLocaleDateString()}</div>
                    <div class="session-title">${ex.title}</div>
                    <div style="font-size: 12px; color: var(--text-secondary); margin-top: 8px;">
                        <div>📷 Camera: ${ex.require_camera ? 'Yes' : 'No'}</div>
                        <div>🎤 Mic: ${ex.require_mic ? 'Yes' : 'No'}</div>
                        <div>💻 Screen: ${ex.require_screen ? 'Yes' : 'No'}</div>
                    </div>
                </div>
            `;
        });
    }

    html += '</div>';
    content.innerHTML = html;
}

function showCreateExamModal() {
    const html = `
        <div class="modal-header">
            <h2 class="modal-title">Link Canvas Quiz</h2>
            <button class="modal-close" onclick="closeModal()">×</button>
        </div>
        <div class="form-group">
            <label class="form-label">Exam Title</label>
            <input type="text" id="exam-title" class="form-input" placeholder="e.g. Midterm Physics">
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
            <label class="form-check">
                <input type="checkbox" id="chk-fs" checked> Enforce Fullscreen Mode
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
        require_camera: document.getElementById('chk-camera').checked,
        require_mic: document.getElementById('chk-mic').checked,
        require_screen: document.getElementById('chk-screen').checked,
        disable_right_click: document.getElementById('chk-rc').checked,
        require_fullscreen: document.getElementById('chk-fs').checked
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

// LIVE VIEW LOGIC
async function loadLiveExamSelect() {
    if(exams.length === 0) {
        const res = await fetch('/api/exams');
        exams = await res.json();
    }
    const content = document.getElementById('content');
    
    if(exams.length === 0) {
        content.innerHTML = '<div class="empty-state">No exams found to monitor.</div>';
        return;
    }

    let selectHtml = '<div style="margin-bottom: 20px;"><label class="form-label">Select Exam to Monitor</label><select id="live-exam-sel" class="form-select" onchange="startLiveMonitoring(this.value)"><option value="">-- Choose Exam --</option>';
    exams.forEach(e => selectHtml += `<option value="${e.id}">${e.title}</option>`);
    selectHtml += '</select></div><div id="live-grid" class="session-grid"></div>';

    content.innerHTML = `
        <div class="page-header">
            <div>
                <h1 class="page-title">Live Monitoring</h1>
                <p class="page-subtitle">Watch student screens in real-time.</p>
            </div>
        </div>
        ${selectHtml}
    `;
}

function startLiveMonitoring(examId) {
    if(!examId) return;
    currentLiveExamId = examId;
    liveStudents = {};
    socket.emit('join_teacher', examId);
    updateLiveGrid();
}

function updateLiveGrid() {
    const grid = document.getElementById('live-grid');
    if(!grid) return;
    grid.innerHTML = '';

    Object.keys(liveStudents).forEach(sessionId => {
        const s = liveStudents[sessionId];
        const statusColor = s.status === 'online' ? 'var(--success)' : 'var(--text-muted)';
        
        let content = '';
        if(s.screenshot) {
            content = `<img src="${s.screenshot}" style="width:100%; height:120px; object-fit:cover; border-radius: 4px; cursor: pointer;" onclick="openFullscreenImg('${s.screenshot}')" />`;
        } else {
            content = `<div style="width:100%; height:120px; background:#ddd; border-radius: 4px; display:flex; align-items:center; justify-content:center; color:#888;">No Signal</div>`;
        }

        grid.innerHTML += `
            <div class="card" style="padding: 12px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <strong style="font-size: 14px;">${s.name || 'Testing...'}</strong>
                    <span style="width: 10px; height: 10px; background: ${statusColor}; border-radius: 50%; display:inline-block;"></span>
                </div>
                ${content}
            </div>
        `;
    });

    if(Object.keys(liveStudents).length === 0) {
        grid.innerHTML = '<div style="color: var(--text-muted); font-size: 14px;">Waiting for students to connect...</div>';
    }
}

function openFullscreenImg(src) {
    document.getElementById('fullscreen-image').src = src;
    document.getElementById('image-overlay').classList.add('active');
}

function closeImage() {
    document.getElementById('image-overlay').classList.remove('active');
}

// REPORTS LOGIC
async function loadReports() {
    if(exams.length === 0) {
        const res = await fetch('/api/exams');
        exams = await res.json();
    }
    const content = document.getElementById('content');
    
    if(exams.length === 0) {
        content.innerHTML = '<div class="empty-state">No exams configured.</div>';
        return;
    }

    let selectHtml = '<div style="margin-bottom: 20px;"><label class="form-label">Select Exam to View Reports</label><select id="report-exam-sel" class="form-select" onchange="fetchReportData(this.value)"><option value="">-- Choose Exam --</option>';
    exams.forEach(e => selectHtml += `<option value="${e.id}">${e.title}</option>`);
    selectHtml += '</select></div><div id="report-content"></div>';

    content.innerHTML = `
        <div class="page-header">
            <div>
                <h1 class="page-title">Proctor Reports</h1>
                <p class="page-subtitle">View logs, tab switches, and security flags.</p>
            </div>
        </div>
        ${selectHtml}
    `;
}

async function fetchReportData(examId) {
    if(!examId) return;
    const res = await fetch(`/api/exams/${examId}/reports`);
    const sessions = await res.json();

    let tableHtml = `
        <div class="table-wrapper">
        <table>
            <thead>
                <tr>
                    <th>Student Name</th>
                    <th>Status</th>
                    <th>Started At</th>
                    <th>Flags / Events</th>
                </tr>
            </thead>
            <tbody>
    `;

    sessions.forEach(s => {
        let logsList = `<ul>`;
        s.logs.forEach(l => {
            logsList += `<li><strong style="color:var(--danger)">${l.event_type}</strong>: ${l.event_message} (${new Date(l.event_timestamp).toLocaleTimeString()})</li>`;
        });
        if(s.logs.length === 0) logsList += "<li>No flags recorded. Good job!</li>";
        logsList += '</ul>';

        tableHtml += `
            <tr>
                <td style="font-weight: 600;">${s.student_name || s.student_canvas_id}</td>
                <td><span class="status-badge status-${s.status === 'completed' ? 'Present' : 'Late'}">${s.status}</span></td>
                <td>${new Date(s.started_at).toLocaleString()}</td>
                <td style="font-size: 13px;">${logsList}</td>
            </tr>
        `;
    });

    tableHtml += '</tbody></table></div>';
    document.getElementById('report-content').innerHTML = tableHtml;
}
