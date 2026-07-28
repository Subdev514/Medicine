const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const mqtt = require('mqtt');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://broker.hivemq.com';
const ADMIN_KEY = process.env.ADMIN_KEY || 'pillpulse-admin-2024';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve admin portal at /admin
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// In-memory sessions store: token -> { username, deviceId, expiresAt }
const sessions = {};
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours

// MQTT and SSE State
let mqttClient = null;
let mqttConnected = false;
let sseClients = [];

// Helper to broadcast SSE messages to all connected browser clients
function broadcastSSE(data) {
  sseClients.forEach(client => {
    try {
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      console.error('Error writing to SSE client:', err);
    }
  });
}

// Database helper functions with auto-schema-migration
function migrateUserBox(box) {
  const migrated = {
    id: box.id,
    name: box.name || '',
    pills: typeof box.pills === 'number' ? box.pills : 0,
    schedules: Array.isArray(box.schedules) ? box.schedules : [],
    history: Array.isArray(box.history) ? box.history : []
  };

  // If the box has an old 'time' string and no schedules, migrate it to the schedules array
  if (box.time && migrated.schedules.length === 0) {
    migrated.schedules.push({
      time: box.time,
      lastTakenDate: null
    });
  }
  return migrated;
}

async function readDB() {
  try {
    const data = await fs.readFile(DB_FILE, 'utf8');
    const parsed = JSON.parse(data);
    let updated = false;

    if (parsed.users) {
      for (const username in parsed.users) {
        const user = parsed.users[username];
        if (!user.syncStatus) {
          user.syncStatus = 'Synced';
          updated = true;
        }
        if (user.boxes) {
          const oldBoxesStr = JSON.stringify(user.boxes);
          user.boxes = user.boxes.map(migrateUserBox);
          if (JSON.stringify(user.boxes) !== oldBoxesStr) {
            updated = true;
          }
        }
      }
    }

    if (updated) {
      await writeDB(parsed);
    }
    return parsed;
  } catch (error) {
    // If file doesn't exist or is invalid, initialize it
    const initialData = { users: {} };
    await fs.writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
    return initialData;
  }
}

async function writeDB(data) {
  await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

// Password hashing utility
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];

  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Session token required' });
  }

  const session = sessions[token];
  if (!session) {
    return res.status(401).json({ message: 'Session expired or invalid' });
  }

  // Check if session has expired
  if (Date.now() > session.expiresAt) {
    delete sessions[token];
    return res.status(401).json({ message: 'Session expired' });
  }

  req.user = session;
  next();
}

// --- Endpoints ---

// 1. User Registration (Admin-only — requires ADMIN_KEY header)
app.post('/api/auth/register', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== ADMIN_KEY) {
    return res.status(403).json({ message: 'Forbidden: Admin access required to register devices.' });
  }

  const { username, password, deviceId, fullName, room, email, notes } = req.body;

  if (!username || !password || !deviceId) {
    return res.status(400).json({ message: 'Username, password, and deviceId are required' });
  }

  try {
    const db = await readDB();
    const normalizedUsername = username.trim().toLowerCase();

    if (db.users[normalizedUsername]) {
      return res.status(400).json({ message: 'Username already taken' });
    }

    // Register user with their device ID and patient metadata
    db.users[normalizedUsername] = {
      username: username.trim(),
      passwordHash: hashPassword(password),
      deviceId: deviceId,
      // Patient metadata managed by admin
      fullName: (fullName || '').trim(),
      room: (room || '').trim(),
      email: (email || '').trim(),
      notes: (notes || '').trim(),
      syncStatus: 'Synced',
      registeredAt: new Date().toISOString(),
      boxes: [
        { id: 1, name: '', pills: 0, schedules: [], history: [] },
        { id: 2, name: '', pills: 0, schedules: [], history: [] },
        { id: 3, name: '', pills: 0, schedules: [], history: [] },
        { id: 4, name: '', pills: 0, schedules: [], history: [] }
      ]
    };

    await writeDB(db);

    res.status(201).json({
      message: 'Device registered successfully',
      username: db.users[normalizedUsername].username,
      deviceId
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// 2. User Login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }

  try {
    const db = await readDB();
    const normalizedUsername = username.trim().toLowerCase();
    const user = db.users[normalizedUsername];

    if (!user) {
      return res.status(400).json({ message: 'Invalid username or password' });
    }

    // Verify Password
    if (user.passwordHash !== hashPassword(password)) {
      return res.status(400).json({ message: 'Invalid username or password' });
    }

    // Create session using the device ID bound to this account
    const token = crypto.randomUUID();
    sessions[token] = {
      username: normalizedUsername,
      deviceId: user.deviceId,
      expiresAt: Date.now() + SESSION_TIMEOUT
    };

    res.json({
      message: 'Login successful',
      token,
      username: user.username,
      fullName: user.fullName || '',
      room: user.room || '',
      email: user.email || '',
      notes: user.notes || '',
      deviceId: user.deviceId
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// 3. Get Medicine Boxes (also returns patient profile)
app.get('/api/medicine', authenticateToken, async (req, res) => {
  try {
    const db = await readDB();
    const user = db.users[req.user.username];
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json({
      syncStatus: user.syncStatus || 'Synced',
      boxes: user.boxes,
      profile: {
        fullName: user.fullName || '',
        room: user.room || '',
        email: user.email || '',
        notes: user.notes || '',
        deviceId: user.deviceId,
        registeredAt: user.registeredAt || null
      }
    });
  } catch (error) {
    console.error('Fetch medicine error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// --- Admin Endpoints ---

// Admin middleware — checks x-admin-key header
function requireAdmin(req, res, next) {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== ADMIN_KEY) {
    return res.status(403).json({ message: 'Forbidden: Admin access required.' });
  }
  next();
}

// A1. List all registered devices/patients
app.get('/api/admin/devices', requireAdmin, async (req, res) => {
  try {
    const db = await readDB();
    const devices = Object.entries(db.users).map(([key, user]) => ({
      username: user.username,
      deviceId: user.deviceId,
      fullName: user.fullName || '',
      room: user.room || '',
      email: user.email || '',
      notes: user.notes || '',
      registeredAt: user.registeredAt || null,
      totalPills: (user.boxes || []).reduce((sum, b) => sum + (b.pills || 0), 0),
      boxCount: (user.boxes || []).filter(b => b.name).length
    }));
    res.json({ devices });
  } catch (error) {
    console.error('Admin list error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// A2. Update patient metadata for a registered device
app.post('/api/admin/devices/update', requireAdmin, async (req, res) => {
  const { username, fullName, room, email, notes, password, deviceId } = req.body;
  if (!username) {
    return res.status(400).json({ message: 'username is required' });
  }

  try {
    const db = await readDB();
    const normalizedUsername = username.trim().toLowerCase();
    const user = db.users[normalizedUsername];
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Update only provided fields
    if (fullName !== undefined) user.fullName = fullName.trim();
    if (room !== undefined) user.room = room.trim();
    if (email !== undefined) user.email = email.trim();
    if (notes !== undefined) user.notes = notes.trim();
    if (deviceId !== undefined && deviceId.trim()) user.deviceId = deviceId.trim();
    if (password !== undefined && password.trim()) {
      user.passwordHash = hashPassword(password.trim());
    }

    await writeDB(db);

    // Broadcast profile update via SSE
    broadcastSSE({
      type: 'profile_updated',
      username: normalizedUsername,
      profile: {
        fullName: user.fullName,
        room: user.room,
        email: user.email,
        notes: user.notes,
        deviceId: user.deviceId
      }
    });

    res.json({ message: 'Patient details updated successfully' });
  } catch (error) {
    console.error('Admin update error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// 4. Update Medicine Boxes Configuration (via UI Edit Form)
app.post('/api/medicine', authenticateToken, async (req, res) => {
  const { boxes } = req.body;

  if (!boxes || !Array.isArray(boxes) || boxes.length !== 4) {
    return res.status(400).json({ message: 'Must provide exactly 4 medicine boxes' });
  }

  try {
    const db = await readDB();
    const user = db.users[req.user.username];
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Validate and update each box
    user.boxes = boxes.map((box, index) => {
      const existingBox = user.boxes[index] || {};
      const schedules = Array.isArray(box.schedules) ? box.schedules.map(s => ({
        time: String(s.time || '').trim(),
        lastTakenDate: s.lastTakenDate || null
      })).filter(s => s.time !== '') : [];

      return {
        id: index + 1,
        name: String(box.name || '').trim(),
        pills: Math.max(0, parseInt(box.pills) || 0),
        schedules: schedules,
        history: Array.isArray(existingBox.history) ? existingBox.history : []
      };
    });

    user.syncStatus = 'Synced';
    await writeDB(db);

    // Publish Synced response to MQTT
    publishDeviceSynced(user.deviceId, user.boxes);
    publishDeviceUpdate(user.deviceId, user.boxes);

    // Broadcast SSE
    broadcastSSE({
      type: 'medicine_updated',
      username: req.user.username,
      deviceId: user.deviceId,
      syncStatus: 'Synced',
      boxes: user.boxes,
      message: 'Medicine configurations updated and synced with IoT device'
    });

    res.json({ message: 'Medicine updated and synced successfully', syncStatus: 'Synced', boxes: user.boxes });
  } catch (error) {
    console.error('Update medicine error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// 4.a Take Medicine Pill (Decrement and log)
app.post('/api/medicine/take', authenticateToken, async (req, res) => {
  const { boxId, time, localDate } = req.body;
  if (!boxId) {
    return res.status(400).json({ message: 'boxId is required' });
  }

  try {
    const db = await readDB();
    const user = db.users[req.user.username];
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const boxIndex = user.boxes.findIndex(b => b.id === boxId);
    if (boxIndex === -1) {
      return res.status(404).json({ message: 'Box not found' });
    }

    const box = user.boxes[boxIndex];
    if (box.pills <= 0) {
      return res.status(400).json({ message: 'Box is empty' });
    }

    const pillsBefore = box.pills;
    box.pills -= 1;

    // Mark schedule as taken if client passed it
    if (time && box.schedules) {
      const schedule = box.schedules.find(s => s.time === time);
      if (schedule) {
        schedule.lastTakenDate = localDate || new Date().toLocaleDateString('en-CA');
      }
    }

    box.history.push({
      timestamp: new Date().toISOString(),
      type: 'taken',
      scheduleTime: time || null,
      source: 'web',
      pillsBefore,
      pillsAfter: box.pills
    });

    await writeDB(db);

    // Publish update to MQTT
    publishDeviceUpdate(user.deviceId, user.boxes);

    // Broadcast SSE
    broadcastSSE({
      type: 'medicine_updated',
      username: req.user.username,
      deviceId: user.deviceId,
      boxes: user.boxes,
      message: `Took 1 pill of ${box.name || `Box ${boxId}`} (Web UI)`
    });

    res.json({ message: 'Pill taken successfully', boxes: user.boxes });
  } catch (error) {
    console.error('Take pill error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// 4.b Refill Medicine Box
app.post('/api/medicine/refill', authenticateToken, async (req, res) => {
  const { boxId, pills } = req.body;
  if (!boxId || typeof pills !== 'number') {
    return res.status(400).json({ message: 'boxId and pills count are required' });
  }

  try {
    const db = await readDB();
    const user = db.users[req.user.username];
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const boxIndex = user.boxes.findIndex(b => b.id === boxId);
    if (boxIndex === -1) {
      return res.status(404).json({ message: 'Box not found' });
    }

    const box = user.boxes[boxIndex];
    const pillsBefore = box.pills;
    box.pills = pills;

    box.history.push({
      timestamp: new Date().toISOString(),
      type: 'refill',
      source: 'web',
      pillsBefore,
      pillsAfter: box.pills
    });

    await writeDB(db);

    // Publish update to MQTT
    publishDeviceUpdate(user.deviceId, user.boxes);

    // Broadcast SSE
    broadcastSSE({
      type: 'medicine_updated',
      username: req.user.username,
      deviceId: user.deviceId,
      boxes: user.boxes,
      message: `${box.name || `Box ${boxId}`} refilled to ${pills} pills`
    });

    res.json({ message: 'Pills refilled successfully', boxes: user.boxes });
  } catch (error) {
    console.error('Refill error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// 5. User Logout
app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token && sessions[token]) {
    delete sessions[token];
  }
  res.json({ message: 'Logged out successfully' });
});

// 6. Server-Sent Events (SSE) Stream
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = { res };
  sseClients.push(client);

  // Send initial connection and status packet
  res.write(`data: ${JSON.stringify({ type: 'connected', mqttConnected, mqttBroker: MQTT_BROKER })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== client);
  });
});

// 7. IoT Device Simulation Endpoints
app.post('/api/simulate/mqtt-take', async (req, res) => {
  const { deviceId, boxId } = req.body;
  if (!deviceId || !boxId) {
    return res.status(400).json({ message: 'deviceId and boxId are required' });
  }

  console.log(`[Simulator] Triggering pill take via simulated MQTT for device ${deviceId}, box ${boxId}`);
  await handleDeviceTakePill(deviceId, parseInt(boxId));
  res.json({ message: 'Simulated MQTT event processed successfully' });
});

app.post('/api/simulate/mqtt-record', async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) {
    return res.status(400).json({ message: 'deviceId is required' });
  }

  console.log(`[Simulator] Triggering recording done via simulated MQTT for device ${deviceId}`);
  await handleDeviceRecordDone(deviceId);
  res.json({ message: 'Simulated MQTT recording event processed successfully' });
});

// 7.a Formal HTTP Endpoints for ESP32 Integration (Approach 1)
app.post('/api/devices/record-done', async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) {
    return res.status(400).json({ message: 'deviceId is required' });
  }

  console.log(`[Device API] Received record-done from device ${deviceId}`);
  await handleDeviceRecordDone(deviceId);
  res.json({ message: 'Status updated to awaiting_input. Awaiting web configuration.' });
});

app.get('/api/devices/status', async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) {
    return res.status(400).json({ message: 'deviceId is required' });
  }

  try {
    const db = await readDB();
    let targetUser = null;
    for (const username in db.users) {
      if (db.users[username].deviceId === deviceId) {
        targetUser = db.users[username];
        break;
      }
    }

    if (!targetUser) {
      return res.status(404).json({ message: 'Device not registered' });
    }

    const box1 = targetUser.boxes.find(b => b.id === 1) || { id: 1, name: '', pills: 0, schedules: [] };

    res.json({
      status: targetUser.syncStatus || 'Synced',
      box: {
        id: box1.id,
        name: box1.name,
        pills: box1.pills,
        schedules: box1.schedules.map(s => s.time || s)
      }
    });
  } catch (err) {
    console.error('Error in /api/devices/status:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.post('/api/devices/take', async (req, res) => {
  const { deviceId, boxId } = req.body;
  if (!deviceId || !boxId) {
    return res.status(400).json({ message: 'deviceId and boxId are required' });
  }

  try {
    const db = await readDB();
    let targetUser = null;
    for (const username in db.users) {
      if (db.users[username].deviceId === deviceId) {
        targetUser = db.users[username];
        break;
      }
    }

    if (!targetUser) {
      return res.status(404).json({ message: 'Device not registered' });
    }

    const boxIdNum = parseInt(boxId);
    const box = targetUser.boxes.find(b => b.id === boxIdNum);
    if (!box) {
      return res.status(404).json({ message: 'Box not found' });
    }

    if (box.pills <= 0) {
      return res.status(400).json({ message: 'Box is empty' });
    }

    await handleDeviceTakePill(deviceId, boxIdNum);

    // Fetch the updated box details to return the new count to the device
    const updatedDb = await readDB();
    let updatedUser = null;
    for (const username in updatedDb.users) {
      if (updatedDb.users[username].deviceId === deviceId) {
        updatedUser = updatedDb.users[username];
        break;
      }
    }
    const updatedBox = updatedUser.boxes.find(b => b.id === boxIdNum);

    res.json({
      message: 'Pill taken successfully',
      remainingPills: updatedBox ? updatedBox.pills : 0
    });
  } catch (err) {
    console.error('Error in /api/devices/take:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// --- MQTT Broker connection and management functions ---
async function handleDeviceTakePill(deviceId, boxId) {
  try {
    const db = await readDB();
    let targetUser = null;
    let targetUsername = null;

    for (const username in db.users) {
      if (db.users[username].deviceId === deviceId) {
        targetUser = db.users[username];
        targetUsername = username;
        break;
      }
    }

    if (!targetUser) {
      console.warn(`[MQTT] No user registered with device ID: ${deviceId}`);
      return;
    }

    const boxIndex = targetUser.boxes.findIndex(b => b.id === boxId);
    if (boxIndex === -1) return;

    const box = targetUser.boxes[boxIndex];
    if (box.pills <= 0) {
      console.warn(`[MQTT] Pill take reported but box ${boxId} is empty.`);
      return;
    }

    const pillsBefore = box.pills;
    box.pills -= 1;

    // Find the next/closest scheduled time to mark as taken today
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA'); // YYYY-MM-DD
    let matchedTime = null;

    if (box.schedules && box.schedules.length > 0) {
      // Find untaken schedules today
      const sortedSchedules = [...box.schedules].sort((a, b) => a.time.localeCompare(b.time));
      const untaken = sortedSchedules.filter(s => s.lastTakenDate !== todayStr);
      if (untaken.length > 0) {
        const schedule = untaken[0];
        schedule.lastTakenDate = todayStr;
        matchedTime = schedule.time;
      }
    }

    box.history.push({
      timestamp: now.toISOString(),
      type: 'taken',
      scheduleTime: matchedTime,
      source: 'device',
      pillsBefore,
      pillsAfter: box.pills
    });

    await writeDB(db);

    // Publish updated status back to MQTT
    publishDeviceUpdate(deviceId, targetUser.boxes);

    // Push notification to frontend clients
    broadcastSSE({
      type: 'medicine_updated',
      username: targetUsername,
      deviceId: deviceId,
      boxes: targetUser.boxes,
      message: `Device consumed 1 pill of ${box.name || `Box ${boxId}`} (MQTT)`
    });
  } catch (err) {
    console.error('Error processing device pill take:', err);
  }
}

async function handleDeviceRecordDone(deviceId) {
  try {
    const db = await readDB();
    let targetUser = null;
    let targetUsername = null;

    for (const username in db.users) {
      if (db.users[username].deviceId === deviceId) {
        targetUser = db.users[username];
        targetUsername = username;
        break;
      }
    }

    if (!targetUser) {
      console.warn(`[MQTT] No user registered with device ID: ${deviceId}`);
      return;
    }

    targetUser.syncStatus = 'awaiting_input';
    await writeDB(db);

    console.log(`[MQTT] Recording completed event processed for device ${deviceId}. User ${targetUsername} marked awaiting input.`);

    // Publish status back to MQTT
    publishDeviceStatus(deviceId, 'awaiting_input', 'Recording completed on IoT device. Awaiting web input.');

    // Push SSE notification to frontend clients
    broadcastSSE({
      type: 'recording_done',
      username: targetUsername,
      deviceId: deviceId,
      syncStatus: 'awaiting_input',
      message: 'Recording completed on IoT device! Please fill in box details.'
    });
  } catch (err) {
    console.error('Error processing device recording done:', err);
  }
}

function initMQTT() {
  console.log(`[MQTT] Connecting to broker at ${MQTT_BROKER}...`);
  try {
    mqttClient = mqtt.connect(MQTT_BROKER, {
      connectTimeout: 5000,
      reconnectPeriod: 5000,
    });

    mqttClient.on('connect', () => {
      console.log('[MQTT] Connected to broker successfully.');
      mqttConnected = true;

      // Subscribe to intake & recording events from devices
      mqttClient.subscribe([
        'pillpulse/devices/+/take',
        'pillpulse/devices/+/record',
        'pillpulse/devices/+/recording_done',
        'pillpulse/devices/+/recorded'
      ], (err) => {
        if (err) {
          console.error('[MQTT] Subscription failed:', err);
        } else {
          console.log('[MQTT] Subscribed to device topics (take, record, recording_done, recorded)');
        }
      });

      broadcastSSE({ type: 'mqtt_status', connected: true, broker: MQTT_BROKER });
    });

    mqttClient.on('message', async (topic, message) => {
      try {
        const topicParts = topic.split('/');
        const deviceId = topicParts[2];
        const action = topicParts[3];

        if (action === 'take') {
          const payload = JSON.parse(message.toString() || '{}');
          const boxId = parseInt(payload.boxId) || 1;
          await handleDeviceTakePill(deviceId, boxId);
        } else if (action === 'record' || action === 'recording_done' || action === 'recorded') {
          await handleDeviceRecordDone(deviceId);
        }
      } catch (err) {
        console.error('[MQTT] Error processing received message:', err);
      }
    });

    mqttClient.on('error', (err) => {
      console.error('[MQTT] Connection error:', err.message);
      mqttConnected = false;
      broadcastSSE({ type: 'mqtt_status', connected: false, broker: MQTT_BROKER });
    });

    mqttClient.on('close', () => {
      if (mqttConnected) {
        console.log('[MQTT] Disconnected from broker.');
        mqttConnected = false;
        broadcastSSE({ type: 'mqtt_status', connected: false, broker: MQTT_BROKER });
      }
    });
  } catch (err) {
    console.error('[MQTT] Initialization error:', err);
  }
}

function publishDeviceUpdate(deviceId, boxes) {
  if (mqttClient && mqttConnected) {
    const topic = `pillpulse/devices/${deviceId}/update`;
    const payload = JSON.stringify({
      deviceId,
      boxes: boxes.map(b => ({
        id: b.id,
        name: b.name,
        pills: b.pills,
        schedules: b.schedules.map(s => s.time)
      }))
    });

    mqttClient.publish(topic, payload, { qos: 1, retain: true }, (err) => {
      if (err) {
        console.error(`[MQTT] Publish update failed for ${deviceId}:`, err);
      } else {
        console.log(`[MQTT] Published updated settings for device ${deviceId}`);
      }
    });
  }
}

function publishDeviceSynced(deviceId, boxes) {
  if (mqttClient && mqttConnected) {
    const topic = `pillpulse/devices/${deviceId}/synced`;
    const payload = JSON.stringify({
      deviceId,
      status: 'Synced',
      message: 'Web profile information updated and synchronized with IoT device',
      syncedAt: new Date().toISOString(),
      boxes: boxes.map(b => ({
        id: b.id,
        name: b.name,
        pills: b.pills,
        schedules: b.schedules.map(s => s.time)
      }))
    });

    mqttClient.publish(topic, payload, { qos: 1, retain: true }, (err) => {
      if (err) {
        console.error(`[MQTT] Publish synced status failed for ${deviceId}:`, err);
      } else {
        console.log(`[MQTT] Published Synced status response for device ${deviceId}`);
      }
    });
  }
}

function publishDeviceStatus(deviceId, status, message) {
  if (mqttClient && mqttConnected) {
    const topic = `pillpulse/devices/${deviceId}/status`;
    const payload = JSON.stringify({
      deviceId,
      status,
      message,
      timestamp: new Date().toISOString()
    });

    mqttClient.publish(topic, payload, { qos: 1, retain: true }, (err) => {
      if (err) {
        console.error(`[MQTT] Publish status failed for ${deviceId}:`, err);
      } else {
        console.log(`[MQTT] Published status [${status}] for device ${deviceId}`);
      }
    });
  }
}

// Redirect all undefined page requests to static index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`Medicine Tracker server running on port ${PORT}`);
  initMQTT();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`[SERVER WARNING] Port ${PORT} is already in use by another process.`);
    const fallbackPort = Number(PORT) + 1;
    console.log(`Attempting to launch server on fallback port ${fallbackPort}...`);
    app.listen(fallbackPort, () => {
      console.log(`Medicine Tracker server running on port ${fallbackPort}`);
      initMQTT();
    });
  } else {
    console.error('[SERVER ERROR]', err);
  }
});