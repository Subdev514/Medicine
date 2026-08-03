// Application State
let deviceId = '';
let authToken = '';
let currentUser = '';
let medicineBoxes = [];
let patientProfile = {};
let editingSchedules = { 1: [], 2: [], 3: [], 4: [] };
let sseSource = null;
let currentRefillBoxId = null;
let currentSyncStatus = 'Synced';

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
  initDeviceId();
  checkSession();
});

// 1. Device ID Handling
function initDeviceId() {
  let storedId = localStorage.getItem('pillpulse_device_id');
  if (!storedId) {
    storedId = crypto.randomUUID();
    localStorage.setItem('pillpulse_device_id', storedId);
  }
  deviceId = storedId;
  
  // Update UI indicators
  const shortId = deviceId.substring(0, 13) + '...';
  document.getElementById('device-id-text').innerText = `Device ID: ${shortId}`;
  
  const badge = document.getElementById('badge-device-id');
  if (badge) {
    badge.innerText = `Device Verified (${deviceId.substring(0, 8)})`;
  }
}

// 2. (Tab switcher removed — registration is now handled at /admin)

// 3. Check Session on Load
function checkSession() {
  const token = localStorage.getItem('pillpulse_auth_token');
  const username = localStorage.getItem('pillpulse_username');

  if (token && username) {
    authToken = token;
    currentUser = username;
    showDashboard();
    fetchMedicine();
    connectSSE();
  } else {
    showAuth();
  }
}

// 4. Handle Authentication (Login only)
async function handleAuth(event, type) {
  event.preventDefault();
  
  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');

  const payload = {
    username: usernameInput.value.trim(),
    password: passwordInput.value,
    deviceId: deviceId
  };

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      showToast(data.message || 'Authentication failed', 'error');
      return;
    }

    authToken = data.token;
    currentUser = data.username;
    patientProfile = {
      fullName: data.fullName || '',
      room: data.room || '',
      email: data.email || '',
      notes: data.notes || '',
      deviceId: data.deviceId || deviceId
    };

    localStorage.setItem('pillpulse_auth_token', authToken);
    localStorage.setItem('pillpulse_username', currentUser);

    showToast('Access granted!', 'success');
    usernameInput.value = '';
    passwordInput.value = '';

    showDashboard();
    fetchMedicine();
    connectSSE();
  } catch (error) {
    console.error('Auth error:', error);
    showToast('Failed to connect to server', 'error');
  }
}

// 5. Logout
async function handleLogout() {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'x-device-id': deviceId
      }
    });
  } catch (e) {
    console.warn('Logout request failed, cleaning local session anyway.');
  }

  authToken = '';
  currentUser = '';
  localStorage.removeItem('pillpulse_auth_token');
  localStorage.removeItem('pillpulse_username');

  if (sseSource) {
    sseSource.close();
    sseSource = null;
  }

  // Reset status badges
  updateSSEStatusBadge(false);
  updateMQTTStatusBadge(false);

  showToast('Logged out successfully', 'info');
  showAuth();
}

// 6. View Switcher Helper
function showDashboard() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('dashboard-screen').classList.remove('hidden');
  document.getElementById('username-display').innerText = currentUser;
  
  const badge = document.getElementById('badge-device-id');
  if (badge) {
    badge.innerText = `Device Verified (${deviceId.substring(0, 8)})`;
  }
}

function showAuth() {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('dashboard-screen').classList.add('hidden');
}

// 7. Establish Real-time SSE Connection
function connectSSE() {
  if (sseSource) {
    sseSource.close();
  }

  sseSource = new EventSource('/api/stream');
  updateSSEStatusBadge(true);

  sseSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('[SSE] Broadcast event received:', data);

      if (data.type === 'connected') {
        updateSSEStatusBadge(true);
        updateMQTTStatusBadge(data.mqttConnected, data.mqttBroker);
      } else if (data.type === 'mqtt_status') {
        updateMQTTStatusBadge(data.connected, data.broker);
      } else if (data.type === 'profile_updated') {
        if (data.username.toLowerCase() === currentUser.toLowerCase()) {
          patientProfile = { ...patientProfile, ...data.profile };
          renderProfile();
          showToast('Your profile was updated by admin.', 'info');
        }
      } else if (data.type === 'recording_done') {
        if (data.username.toLowerCase() === currentUser.toLowerCase()) {
          updateSyncStatusUI('awaiting_input');
          showToast('🎙️ Recording finished on IoT device! Please input box details.', 'warning');
          logToSimulatorConsole(`[MQTT] Event recording_done received for device ${data.deviceId}. Awaiting box input.`);
        }
      } else if (data.type === 'medicine_updated') {
        // Only update if it belongs to the current user
        if (data.username.toLowerCase() === currentUser.toLowerCase()) {
          medicineBoxes = data.boxes;
          if (data.syncStatus) {
            updateSyncStatusUI(data.syncStatus);
          }
          renderBoxes();
          renderHistory();
          showToast(data.message || 'Medicine updated.', 'info');
          logToSimulatorConsole(`[BROKER] Medicine box update: ${data.message}`);
        }
      }
    } catch (err) {
      console.error('[SSE] Error processing stream message:', err);
    }
  };

  sseSource.onerror = (err) => {
    console.error('[SSE] Stream error, reconnecting...');
    updateSSEStatusBadge(false);
    updateMQTTStatusBadge(false);
  };
}

function updateSSEStatusBadge(connected) {
  const badge = document.getElementById('sse-status-badge');
  const text = document.getElementById('sse-status-text');
  const pulse = document.getElementById('sse-pulse');

  if (connected) {
    badge.className = 'status-badge-live connected';
    text.innerText = 'Server Stream: Connected';
    pulse.className = 'pulse-indicator green';
  } else {
    badge.className = 'status-badge-live disconnected';
    text.innerText = 'Server Stream: Offline';
    pulse.className = 'pulse-indicator red';
  }
}

function updateMQTTStatusBadge(connected, brokerUrl = '') {
  const badge = document.getElementById('mqtt-status-badge');
  const text = document.getElementById('mqtt-status-text');
  const pulse = document.getElementById('mqtt-pulse');

  if (connected) {
    badge.className = 'status-badge-live connected';
    text.innerText = `MQTT: Active`;
    badge.title = `Connected to broker: ${brokerUrl}`;
    pulse.className = 'pulse-indicator green';
  } else {
    badge.className = 'status-badge-live disconnected';
    text.innerText = 'MQTT Broker: Offline';
    badge.title = 'Offline or Mock mode';
    pulse.className = 'pulse-indicator red';
  }
}

function updateSyncStatusUI(status) {
  currentSyncStatus = status || 'Synced';
  const badge = document.getElementById('sync-status-badge');
  const text = document.getElementById('sync-status-text');
  const pulse = document.getElementById('sync-pulse');
  const banner = document.getElementById('recording-alert-banner');

  if (currentSyncStatus === 'awaiting_input') {
    if (badge) {
      badge.className = 'status-badge-live warning';
      badge.title = 'IoT device recording completed. Awaiting box details input from web.';
    }
    if (text) text.innerText = 'Sync: Awaiting Input';
    if (pulse) pulse.className = 'pulse-indicator yellow';
    if (banner) banner.classList.remove('hidden');
  } else {
    if (badge) {
      badge.className = 'status-badge-live connected';
      badge.title = 'IoT Device & Web Profile are fully synced.';
    }
    if (text) text.innerText = 'Sync: Synced';
    if (pulse) pulse.className = 'pulse-indicator green';
    if (banner) banner.classList.add('hidden');
  }
}

// 8. Get Medicine Data
async function fetchMedicine() {
  try {
    const response = await fetch('/api/medicine', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'x-device-id': deviceId
      }
    });

    if (response.status === 401 || response.status === 403) {
      handleLogout();
      return;
    }

    const data = await response.json();
    if (response.ok) {
      medicineBoxes = data.boxes;
      if (data.profile) {
        patientProfile = data.profile;
      }
      updateSyncStatusUI(data.syncStatus || 'Synced');
      renderBoxes();
      renderHistory();
      renderProfile();
    } else {
      showToast(data.message || 'Failed to fetch medicine list', 'error');
    }
  } catch (error) {
    console.error('Fetch error:', error);
    showToast('Error connecting to database', 'error');
  }
}

// 8b. Render Patient Profile Card
function renderProfile() {
  const fullName = patientProfile.fullName || '';
  const room = patientProfile.room || '';
  const email = patientProfile.email || '';
  const notes = patientProfile.notes || '';
  const boundDeviceId = patientProfile.deviceId || deviceId;

  const card = document.getElementById('patient-profile-card');
  const nameEl = document.getElementById('profile-full-name');
  const roomEl = document.getElementById('profile-room');
  const emailEl = document.getElementById('profile-email');
  const notesEl = document.getElementById('profile-notes');
  const deviceEl = document.getElementById('profile-device-id');

  if (!card) return;

  nameEl.innerText = fullName || currentUser;

  if (room) {
    roomEl.innerText = `🏥 ${room}`;
    roomEl.style.display = '';
  } else {
    roomEl.style.display = 'none';
  }

  if (email) {
    emailEl.innerText = `✉️ ${email}`;
    emailEl.style.display = '';
  } else {
    emailEl.style.display = 'none';
  }

  if (notes) {
    notesEl.innerText = `📋 ${notes}`;
    notesEl.style.display = '';
  } else {
    notesEl.style.display = 'none';
  }

  deviceEl.innerText = boundDeviceId;
}

// 9. Render Medicine Cards and Schedules
function renderBoxes() {
  const todayStr = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
  const now = new Date();

  medicineBoxes.forEach((box) => {
    const cardEl = document.getElementById(`box-card-${box.id}`);
    const nameEl = document.getElementById(`med-name-${box.id}`);
    const pillsEl = document.getElementById(`med-pills-${box.id}`);
    const statusEl = document.getElementById(`box-status-${box.id}`);
    const takeBtn = document.getElementById(`take-btn-${box.id}`);
    const schedulesContainer = document.getElementById(`schedules-container-${box.id}`);

    // If box is unconfigured
    if (!box.name.trim()) {
      cardEl.classList.add('empty-slot');
      nameEl.innerText = 'Empty Slot';
      pillsEl.innerText = '0';
      statusEl.innerText = 'Empty';
      statusEl.className = 'status-badge empty';
      takeBtn.disabled = true;
      takeBtn.innerText = 'No Pills';
      schedulesContainer.innerHTML = '<div class="no-schedules">Not configured</div>';
    } else {
      cardEl.classList.remove('empty-slot');
      nameEl.innerText = box.name;
      pillsEl.innerText = box.pills;
      
      // Determine overall box status based on pill counts
      if (box.pills === 0) {
        statusEl.innerText = 'Refill Needed';
        statusEl.className = 'status-badge empty';
        takeBtn.disabled = true;
        takeBtn.innerText = 'Out of Pills';
      } else {
        statusEl.innerText = 'Active';
        statusEl.className = 'status-badge active';
        takeBtn.disabled = false;
        takeBtn.innerText = 'Take 1 Pill (Ad-hoc)';
      }

      // Render Schedules Chips
      if (!box.schedules || box.schedules.length === 0) {
        schedulesContainer.innerHTML = '<div class="no-schedules">No daily schedules set</div>';
      } else {
        // Sort schedules chronologically
        const sortedSchedules = [...box.schedules].sort((a, b) => a.time.localeCompare(b.time));
        
        schedulesContainer.innerHTML = sortedSchedules.map(schedule => {
          const scheduleTime = schedule.time;
          const lastTaken = schedule.lastTakenDate;
          
          let status = 'pending';
          let statusText = 'Scheduled';
          let icon = '⏰';

          if (lastTaken === todayStr) {
            status = 'taken';
            statusText = 'Taken Today';
            icon = '✅';
          } else {
            // Check if alarm time is in the past today
            const [h, m] = scheduleTime.split(':');
            const alarmDate = new Date();
            alarmDate.setHours(parseInt(h), parseInt(m), 0, 0);
            
            if (now > alarmDate) {
              status = 'missed';
              statusText = 'Missed Alarm';
              icon = '⚠️';
            }
          }

          const actionButton = status !== 'taken' && box.pills > 0
            ? `<button onclick="takeSchedulePill(${box.id}, '${scheduleTime}')" class="schedule-take-btn" title="Mark as Taken">✓</button>`
            : '';

          return `
            <div class="schedule-chip ${status}" title="${statusText}">
              <span class="schedule-chip-icon">${icon}</span>
              <span class="schedule-chip-time">${formatTime(scheduleTime)}</span>
              ${actionButton}
            </div>
          `;
        }).join('');
      }
    }
  });
}

// 10. Render Intake History Logs
function renderHistory() {
  const container = document.getElementById('history-timeline');
  
  // Collect history from all boxes
  let allLogs = [];
  medicineBoxes.forEach(box => {
    if (box.history && box.history.length > 0) {
      box.history.forEach(log => {
        allLogs.push({
          ...log,
          medName: box.name || `Box ${box.id}`,
          boxId: box.id
        });
      });
    }
  });

  // Sort logs: newest first
  allLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  if (allLogs.length === 0) {
    container.innerHTML = '<div class="timeline-empty">No activity logs recorded yet.</div>';
    return;
  }

  // Render top 15 logs
  const logsToRender = allLogs.slice(0, 15);
  container.innerHTML = logsToRender.map(log => {
    const timeStr = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = new Date(log.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
    
    let badgeType = 'taken';
    let content = '';

    if (log.type === 'taken') {
      badgeType = 'taken';
      let detail = log.scheduleTime ? `for ${formatTime(log.scheduleTime)} schedule` : 'ad-hoc';
      if (log.removedAlarm) {
        detail += ` (Alarm at ${formatTime(log.removedAlarm)} removed ahead of time)`;
      }
      const source = log.source === 'device' ? '🔌 IoT Device' : '💻 Web App';
      content = `Took 1 pill of <strong>${log.medName}</strong> (${detail}) via ${source}. Remaining: ${log.pillsAfter}`;
    } else if (log.type === 'refill') {
      badgeType = 'refill';
      content = `Refilled <strong>${log.medName}</strong> to <strong>${log.pillsAfter}</strong> pills. (Was: ${log.pillsBefore})`;
    }

    return `
      <div class="timeline-item">
        <div class="timeline-marker ${badgeType}"></div>
        <div class="timeline-content">
          <div class="timeline-time">${dateStr} at ${timeStr}</div>
          <div class="timeline-desc">${content}</div>
        </div>
      </div>
    `;
  }).join('');
}

// 11. Format 24h Time input into 12h Time
function formatTime(timeStr) {
  if (!timeStr) return 'Not scheduled';
  try {
    const [hours, minutes] = timeStr.split(':');
    const h = parseInt(hours);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const formattedHours = h % 12 || 12;
    return `${formattedHours}:${minutes} ${ampm}`;
  } catch (e) {
    return timeStr;
  }
}

// 12. Toggle Edit Mode and Populate Schedules list
function toggleEdit(boxId, showEdit) {
  const viewPanel = document.getElementById(`box-view-${boxId}`);
  const editPanel = document.getElementById(`box-edit-${boxId}`);

  if (showEdit) {
    const box = medicineBoxes.find(b => b.id === boxId);
    document.getElementById(`edit-name-${boxId}`).value = box ? box.name : '';
    document.getElementById(`edit-pills-${boxId}`).value = box ? box.pills : 0;
    
    // Copy schedules list for editing
    editingSchedules[boxId] = box && box.schedules ? [...box.schedules] : [];
    renderEditSchedulesList(boxId);

    viewPanel.classList.add('hidden');
    editPanel.classList.remove('hidden');
  } else {
    viewPanel.classList.remove('hidden');
    editPanel.classList.add('hidden');
  }
}

// 13. Dynamic editing of Schedules in Edit Form
function renderEditSchedulesList(boxId) {
  const listEl = document.getElementById(`edit-schedules-list-${boxId}`);
  const schedules = editingSchedules[boxId];

  if (schedules.length === 0) {
    listEl.innerHTML = '<div class="no-schedules-edit">No alarms set. Add one below.</div>';
    return;
  }

  // Sort chronologically in editor too
  schedules.sort((a, b) => a.time.localeCompare(b.time));

  listEl.innerHTML = schedules.map(s => `
    <div class="edit-schedule-item">
      <span>⏰ ${formatTime(s.time)}</span>
      <button type="button" class="remove-schedule-btn" onclick="removeScheduleTime(${boxId}, '${s.time}')">Remove</button>
    </div>
  `).join('');
}

function addScheduleTimeInput(boxId) {
  const timeInput = document.getElementById(`add-time-${boxId}`);
  const timeVal = timeInput.value;

  if (!timeVal) {
    showToast('Please select a valid time', 'warning');
    return;
  }

  // Check if already exists in editing schedules
  if (editingSchedules[boxId].some(s => s.time === timeVal)) {
    showToast('Alarm already exists for this time', 'warning');
    return;
  }

  editingSchedules[boxId].push({
    time: timeVal,
    lastTakenDate: null
  });

  timeInput.value = '';
  renderEditSchedulesList(boxId);
}

function removeScheduleTime(boxId, timeStr) {
  editingSchedules[boxId] = editingSchedules[boxId].filter(s => s.time !== timeStr);
  renderEditSchedulesList(boxId);
}

// 14. Adjust Pill counter values in forms
function adjustPillInput(boxId, change) {
  const input = document.getElementById(`edit-pills-${boxId}`);
  let val = parseInt(input.value) || 0;
  val = Math.max(0, val + change);
  input.value = val;
}

// 15. Save Box configuration
async function saveBox(event, boxId) {
  event.preventDefault();

  const name = document.getElementById(`edit-name-${boxId}`).value.trim();
  const pills = parseInt(document.getElementById(`edit-pills-${boxId}`).value) || 0;
  const schedules = editingSchedules[boxId];

  // Build the updated boxes payload
  const updatedBoxes = medicineBoxes.map(b => {
    if (b.id === boxId) {
      return { id: boxId, name, pills, schedules };
    }
    return b;
  });

  await pushMedicineUpdate(updatedBoxes);
  toggleEdit(boxId, false);
}

// 16. Fast Ad-hoc "Take Pill" Action
async function takePill(boxId) {
  const box = medicineBoxes.find(b => b.id === boxId);
  if (!box || box.pills <= 0) {
    showToast('Box is empty, please refill!', 'warning');
    return;
  }

  const now = new Date();
  const curHour = String(now.getHours()).padStart(2, '0');
  const curMin = String(now.getMinutes()).padStart(2, '0');
  const localTime = `${curHour}:${curMin}`;

  try {
    const response = await fetch('/api/medicine/take', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
        'x-device-id': deviceId
      },
      body: JSON.stringify({ boxId, localTime })
    });

    const data = await response.json();
    if (response.ok) {
      medicineBoxes = data.boxes;
      renderBoxes();
      renderHistory();
      showToast(data.message || `Took 1 pill of ${box.name}.`, 'success');
    } else {
      showToast(data.message || 'Failed to record intake', 'error');
    }
  } catch (error) {
    console.error('Intake error:', error);
    showToast('Connection error, could not save intake', 'error');
  }
}

// 17. Take pill for a specific schedule
async function takeSchedulePill(boxId, scheduleTime) {
  const box = medicineBoxes.find(b => b.id === boxId);
  if (!box || box.pills <= 0) {
    showToast('Box is empty, please refill!', 'warning');
    return;
  }

  const todayStr = new Date().toLocaleDateString('en-CA');

  try {
    const response = await fetch('/api/medicine/take', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
        'x-device-id': deviceId
      },
      body: JSON.stringify({
        boxId,
        time: scheduleTime,
        localDate: todayStr
      })
    });

    const data = await response.json();
    if (response.ok) {
      medicineBoxes = data.boxes;
      renderBoxes();
      renderHistory();
      showToast(`Took pill of ${box.name} for schedule ${formatTime(scheduleTime)}.`, 'success');
    } else {
      showToast(data.message || 'Failed to mark schedule as taken', 'error');
    }
  } catch (err) {
    console.error('Take schedule pill error:', err);
    showToast('Connection error, could not update schedule', 'error');
  }
}

// 18. Refill Modal Handlers
function openRefillModal(boxId) {
  currentRefillBoxId = boxId;
  const box = medicineBoxes.find(b => b.id === boxId);
  
  document.getElementById('refill-modal-title').innerText = `Refilling ${box && box.name ? box.name : `Box ${boxId}`}`;
  document.getElementById('refill-qty-input').value = box ? Math.max(30, box.pills + 30) : 30;
  
  document.getElementById('refill-modal').classList.remove('hidden');
}

function closeRefillModal() {
  document.getElementById('refill-modal').classList.add('hidden');
  currentRefillBoxId = null;
}

function adjustRefillInput(change) {
  const input = document.getElementById('refill-qty-input');
  let val = parseInt(input.value) || 0;
  val = Math.max(0, val + change);
  input.value = val;
}

async function submitRefill() {
  if (currentRefillBoxId === null) return;
  const qty = parseInt(document.getElementById('refill-qty-input').value) || 0;

  try {
    const response = await fetch('/api/medicine/refill', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
        'x-device-id': deviceId
      },
      body: JSON.stringify({
        boxId: currentRefillBoxId,
        pills: qty
      })
    });

    const data = await response.json();
    if (response.ok) {
      medicineBoxes = data.boxes;
      renderBoxes();
      renderHistory();
      showToast('Box refilled successfully!', 'success');
      closeRefillModal();
    } else {
      showToast(data.message || 'Failed to refill box', 'error');
    }
  } catch (error) {
    console.error('Refill error:', error);
    showToast('Connection error, could not refill', 'error');
  }
}

// 19. IoT Device simulator triggers
async function simulateMqttTake(boxId) {
  logToSimulatorConsole(`[BUTTON] Simulated physical button press on Box ${boxId}...`);
  try {
    const response = await fetch('/api/simulate/mqtt-take', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        deviceId: deviceId,
        boxId: boxId
      })
    });

    const data = await response.json();
    if (response.ok) {
      logToSimulatorConsole(`[MQTT] Published event to topic pillpulse/devices/${deviceId}/take with payload {"boxId": ${boxId}}`);
    } else {
      logToSimulatorConsole(`[ERROR] Simulator endpoint returned error: ${data.message}`);
    }
  } catch (err) {
    console.error('Simulator trigger error:', err);
    logToSimulatorConsole('[ERROR] Simulator failed to connect to web server.');
  }
}

async function simulateMqttRecord() {
  logToSimulatorConsole(`[BUTTON] Simulated IoT Recording Done event for device ${deviceId}...`);
  try {
    const response = await fetch('/api/simulate/mqtt-record', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ deviceId: deviceId })
    });

    const data = await response.json();
    if (response.ok) {
      logToSimulatorConsole(`[MQTT] Published event to topic pillpulse/devices/${deviceId}/recording_done`);
    } else {
      logToSimulatorConsole(`[ERROR] Simulator endpoint returned error: ${data.message}`);
    }
  } catch (err) {
    console.error('Simulator recording error:', err);
    logToSimulatorConsole('[ERROR] Simulator failed to connect to web server.');
  }
}

function scrollToBoxes() {
  const container = document.querySelector('.boxes-grid');
  if (container) {
    container.scrollIntoView({ behavior: 'smooth' });
  }
}

function logToSimulatorConsole(text) {
  const output = document.getElementById('sim-console-output');
  if (!output) return;
  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0];
  
  // Format as line
  const logLine = `[${timeStr}] ${text}`;
  
  // Append
  output.innerHTML += `\n${logLine}`;
  // Scroll to bottom
  output.scrollTop = output.scrollHeight;
}

// 20. Push Updates helper
async function pushMedicineUpdate(boxesPayload) {
  try {
    const response = await fetch('/api/medicine', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
        'x-device-id': deviceId
      },
      body: JSON.stringify({ boxes: boxesPayload })
    });

    const data = await response.json();

    if (response.ok) {
      medicineBoxes = data.boxes;
      if (data.syncStatus) {
        updateSyncStatusUI(data.syncStatus);
      } else {
        updateSyncStatusUI('Synced');
      }
      renderBoxes();
      renderHistory();
      showToast('Medicine configuration updated & synced with IoT device!', 'success');
      logToSimulatorConsole(`[SYNC] Response sent: Both IoT device and web profile are now Synced.`);
    } else {
      showToast(data.message || 'Failed to update medicine', 'error');
    }
  } catch (error) {
    console.error('Update medicine error:', error);
    showToast('Connection error, could not save medicine', 'error');
  }
}

// 21. Toast notification system
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.classList.add('toast', type);
  
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '❌';
  if (type === 'warning') icon = '⚠️';

  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  container.appendChild(toast);

  // Auto-remove after 4 seconds
  setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('animationend', () => {
      toast.remove();
    });
  }, 4000);
}
