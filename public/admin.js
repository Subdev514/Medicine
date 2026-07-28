// Admin Portal State
let adminKey = '';
let currentEditUsername = '';

// Browser device ID for helper button
let localDeviceId = (() => {
  let id = localStorage.getItem('pillpulse_device_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('pillpulse_device_id', id);
  }
  return id;
})();

// ===== Admin Key Gate =====
function submitAdminKey() {
  const keyInput = document.getElementById('admin-key-input');
  const key = keyInput.value.trim();
  if (!key) {
    showToast('Please enter the admin key', 'warning');
    return;
  }
  adminKey = key;

  // Test the key by fetching devices
  fetch('/api/admin/devices', {
    headers: { 'x-admin-key': adminKey }
  }).then(res => {
    if (res.ok) {
      document.getElementById('admin-gate').classList.add('hidden');
      loadDevices();
    } else {
      adminKey = '';
      showToast('Invalid admin key. Access denied.', 'error');
      keyInput.value = '';
    }
  }).catch(() => {
    showToast('Could not connect to server', 'error');
  });
}

// Allow Enter key in admin key input
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('admin-key-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitAdminKey();
  });
});

// ===== Section navigation =====
function showSection(name) {
  document.querySelectorAll('.admin-section').forEach(s => s.classList.add('hidden'));
  document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'));
  document.getElementById(`section-${name}`).classList.remove('hidden');
  document.querySelector(`.sidebar-link[onclick="showSection('${name}')"]`).classList.add('active');
  if (name === 'devices') loadDevices();
}

// ===== Load & Render Devices Table =====
async function loadDevices() {
  const tbody = document.getElementById('devices-tbody');
  tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Loading...</td></tr>';

  try {
    const res = await fetch('/api/admin/devices', {
      headers: { 'x-admin-key': adminKey }
    });
    if (!res.ok) {
      showToast('Failed to load devices', 'error');
      return;
    }
    const data = await res.json();
    renderDevicesTable(data.devices);
  } catch (e) {
    showToast('Connection error', 'error');
  }
}

function renderDevicesTable(devices) {
  const tbody = document.getElementById('devices-tbody');

  if (!devices || devices.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">No devices registered yet. Go to "Register New Device".</td></tr>';
    return;
  }

  tbody.innerHTML = devices.map(d => {
    const registeredDate = d.registeredAt
      ? new Date(d.registeredAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
    const shortDeviceId = d.deviceId ? d.deviceId.substring(0, 12) + '...' : '—';
    const patientName = d.fullName || `<span class="no-value">Not set</span>`;
    const roomDisplay = d.room ? `<span class="table-tag">${d.room}</span>` : `<span class="no-value">—</span>`;
    const emailDisplay = d.email || `<span class="no-value">—</span>`;
    const deviceData = encodeURIComponent(JSON.stringify(d));

    return `
      <tr class="device-row">
        <td>
          <div class="patient-cell">
            <div class="patient-avatar">${(d.fullName || d.username).charAt(0).toUpperCase()}</div>
            <div class="patient-name">${patientName}</div>
          </div>
        </td>
        <td><code>${d.username}</code></td>
        <td>${roomDisplay}</td>
        <td>${emailDisplay}</td>
        <td><code class="device-id-cell" title="${d.deviceId}">${shortDeviceId}</code></td>
        <td>${registeredDate}</td>
        <td>
          <span class="pill-count-badge ${d.totalPills === 0 ? 'empty' : ''}">
            💊 ${d.totalPills}
          </span>
        </td>
        <td>
          <button onclick="openEditModalByData('${deviceData}')" class="btn btn-outline btn-sm">Edit</button>
        </td>
      </tr>
    `;
  }).join('');
}

// Wrapper to decode URL-encoded device data from inline onclick
function openEditModalByData(encodedData) {
  try {
    const device = JSON.parse(decodeURIComponent(encodedData));
    openEditModal(device);
  } catch (e) {
    showToast('Could not open edit modal — data parse error', 'error');
  }
}

// ===== Edit Patient Modal =====
function openEditModal(device) {
  currentEditUsername = device.username;
  document.getElementById('edit-username').value = device.username;
  document.getElementById('edit-fullname').value = device.fullName || '';
  document.getElementById('edit-room').value = device.room || '';
  document.getElementById('edit-email').value = device.email || '';
  document.getElementById('edit-notes').value = device.notes || '';
  document.getElementById('edit-password').value = '';
  document.getElementById('edit-device-id').value = '';
  document.getElementById('edit-modal').classList.remove('hidden');
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.add('hidden');
  currentEditUsername = '';
}

async function submitEdit(event) {
  event.preventDefault();
  const payload = {
    username: document.getElementById('edit-username').value,
    fullName: document.getElementById('edit-fullname').value,
    room: document.getElementById('edit-room').value,
    email: document.getElementById('edit-email').value,
    notes: document.getElementById('edit-notes').value,
    password: document.getElementById('edit-password').value || undefined,
    deviceId: document.getElementById('edit-device-id').value || undefined
  };

  try {
    const res = await fetch('/api/admin/devices/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': adminKey
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok) {
      showToast('Patient details updated successfully!', 'success');
      closeEditModal();
      loadDevices();
    } else {
      showToast(data.message || 'Update failed', 'error');
    }
  } catch (e) {
    showToast('Connection error', 'error');
  }
}

// ===== Register New Device =====
function fillCurrentDeviceId() {
  document.getElementById('reg-device-id').value = localDeviceId;
}

function generateNewDeviceId() {
  document.getElementById('reg-device-id').value = crypto.randomUUID();
}

function resetRegisterForm() {
  document.getElementById('register-form').reset();
}

async function submitRegister(event) {
  event.preventDefault();

  const payload = {
    username: document.getElementById('reg-username').value.trim(),
    password: document.getElementById('reg-password').value,
    deviceId: document.getElementById('reg-device-id').value.trim(),
    fullName: document.getElementById('reg-fullname').value.trim(),
    room: document.getElementById('reg-room').value.trim(),
    email: document.getElementById('reg-email').value.trim(),
    notes: document.getElementById('reg-notes').value.trim()
  };

  if (!payload.username || !payload.password || !payload.deviceId) {
    showToast('Username, password, and device ID are required', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': adminKey
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok) {
      showToast(`Device registered for "${payload.fullName || payload.username}" successfully!`, 'success');
      resetRegisterForm();
      showSection('devices');
    } else {
      showToast(data.message || 'Registration failed', 'error');
    }
  } catch (e) {
    showToast('Connection error', 'error');
  }
}

// ===== Toast notification =====
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

  setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('animationend', () => toast.remove());
  }, 4000);
}
