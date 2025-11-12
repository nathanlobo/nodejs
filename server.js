const express = require('express');
const { exec, spawn, execFile } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const app = express();
const server = http.createServer(app);

// Attach Socket.IO with dynamic CORS configuration
// In production, this allows any origin (safe since we're serving same-origin)
// In development, allows localhost and common dev ports
const io = socketIo(server, {
  cors: {
    origin: function(origin, callback) {
      // Allow requests with no origin (like mobile apps, curl, Postman)
      if (!origin) return callback(null, true);
      
      // In production (Render), allow same-origin automatically
      // In development, allow localhost and dev tunnels
      const allowedPatterns = [
        /^http:\/\/localhost:\d+$/,
        /^http:\/\/127\.0\.0\.1:\d+$/,
        /^https:\/\/.*\.devtunnels\.ms$/,
        /^https:\/\/.*\.onrender\.com$/,
      ];
      
      const isAllowed = allowedPatterns.some(pattern => pattern.test(origin));
      if (isAllowed) {
        callback(null, true);
      } else {
        // Still allow it but log for debugging
        console.log('CORS: Allowing origin:', origin);
        callback(null, true);
      }
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
});

const port = process.env.PORT || 3000;
app.use(express.json());
// Serve static assets (index.html, style.css, etc.) for online/container environments
app.use(express.static(__dirname));

// Create temp directory for storing temporary cpp files and executables
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  console.log('Created temp directory:', TEMP_DIR);
}

const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/nathanlobo/CodeStore/main/DSCpp/';
let idToRepoPath = {};
try {
  const mapRaw = fs.readFileSync(path.join(__dirname, 'id-map.json'), 'utf8');
  idToRepoPath = JSON.parse(mapRaw);
  const keys = Object.keys(idToRepoPath || {});
  console.log(`Loaded id->repo mapping from id-map.json (${keys.length} ids)`);
} catch (e) {
  console.warn('Could not load id-map.json, falling back to local file names');
  idToRepoPath = {};
}

// Load preferred users data for code customization
let prefedUsers = {};
try {
  const prefedRaw = fs.readFileSync(path.join(__dirname, 'prefedUser.json'), 'utf8');
  const prefedData = JSON.parse(prefedRaw);
  // Flatten the structure for easy lookup by roll_no
  if (prefedData && prefedData['ecomp24-28']) {
    prefedData['ecomp24-28'].forEach(user => {
      if (user.roll_no) {
        // Store with lowercase key for case-insensitive lookup
        const rollKey = user.roll_no.trim().toLowerCase();
        prefedUsers[rollKey] = user;
      }
    });
  }
  console.log(`Loaded ${Object.keys(prefedUsers).length} preferred users from prefedUser.json`);
} catch (e) {
  console.warn('Could not load prefedUser.json, code customization disabled');
  prefedUsers = {};
}

// Function to customize C++ code based on user data
function customizeCode(codeContent, rollNo) {
  if (!rollNo || !prefedUsers[rollNo.toLowerCase()]) {
    return codeContent; // No customization if user not found
  }
  
  const user = prefedUsers[rollNo.toLowerCase()];
  const { fname, lname, gender } = user;
  
  if (!fname || !lname || !gender) {
    console.warn(`Incomplete user data for roll ${rollNo}`);
    return codeContent;
  }
  
  let customized = codeContent;
  
  // Replace Nathan with first name
  customized = customized.replace(/Nathan/g, fname);
  customized = customized.replace(/nathan/g, fname.toLowerCase());
  
  // Replace Lobo with last name
  customized = customized.replace(/Lobo/g, lname);
  customized = customized.replace(/lobo/g, lname.toLowerCase());
  
  // Replace Mr with Mrs if female
  if (gender.toUpperCase() === 'F') {
    customized = customized.replace(/\bMr\b/g, 'Mrs');
    customized = customized.replace(/\bMr\./g, 'Mrs.');
  }
  
  console.log(`Customized code for ${rollNo}: ${fname} ${lname} (${gender})`);
  return customized;
}
app.get('/mapping', (req, res) => {
  const id = req.query && req.query.id ? String(req.query.id) : null;
  if (!id) return res.json(idToRepoPath);
  const p = idToRepoPath[id] || null;
  return res.json({ id, path: p });
});
function fetchFromGithubAndWrite(repoRelativePath, destPath, cb) {
  const url = GITHUB_RAW_BASE + repoRelativePath;
  https.get(url, (res) => {
    if (res.statusCode !== 200) {
      let errData = '';
      res.on('data', (d) => { errData += d.toString(); });
      res.on('end', () => cb(new Error(`Failed to fetch ${url}: ${res.statusCode}`)));
      return;
    }
    const ws = fs.createWriteStream(destPath);
    res.pipe(ws);
    ws.on('finish', () => ws.close(cb));
    ws.on('error', (err) => cb(err));
  }).on('error', (err) => cb(err));
}
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/run', (req, res) => {
  const id = String(req.query.id || '1');
  let cppName;
  const repoPath = idToRepoPath[id];
  const isWin = process.platform === 'win32';
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tempCpp = path.join(TEMP_DIR, `temp_${unique}.cpp`);
  const exeFile = path.join(TEMP_DIR, isWin ? `exe_${unique}.exe` : `exe_${unique}`);
  const doCompile = (cppFilePath) => {
    const compileCmd = `g++ "${cppFilePath}" -o "${exeFile}"`;
    exec(compileCmd, { timeout: 20000 }, (compileErr, compileStdout, compileStderr) => {
      if (compileErr) {
        if (repoPath) fs.unlink(cppFilePath, () => {});
        res.type('text').status(500).send(`Compilation failed:\n${compileStderr || compileErr.message}`);
        return;
      }
    const providedInput = (req.query && req.query.input) || (req.body && req.body.input) || '';
    const child = spawn(exeFile, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let errOut = '';
    let killedByTimeout = false;
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { errOut += d.toString(); });
    if (providedInput) {
      try {
        child.stdin.write(String(providedInput));
      } catch (e) {/* ignore */}
      try { child.stdin.end(); } catch (e) {}
    }
    const killTimer = setTimeout(() => {
      killedByTimeout = true;
      try { child.kill(); } catch (e) {}
    }, 30000);
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      // Clean up exe
      fs.unlink(exeFile, () => {});
      if (repoPath) fs.unlink(cppFilePath, () => {});
      let body = out || '';
      if (errOut) body += `\nSTDERR:\n${errOut}`;
      if (killedByTimeout) body += `\n[Process was killed (timeout or signal)]`;
      if (code !== null && code !== undefined) body += `\n[Exit code: ${code}]`;
      res.type('text').status(200).send(body || '[No output]');
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      fs.unlink(exeFile, () => {});
      if (repoPath) fs.unlink(cppFilePath, () => {});
      const body = `Process error: ${err.message}`;
      res.type('text').status(200).send(body);
    });
    });
  };
  if (repoPath) {
    fetchFromGithubAndWrite(repoPath, tempCpp, (err) => {
      if (err) return res.type('text').status(500).send(`Failed to fetch source from GitHub: ${err.message}`);
      doCompile(tempCpp);
    });
  } else {
    const localCpp = path.join(__dirname, cppName);
    doCompile(localCpp);
  }
});
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Store reference to current running child process for this socket
  let currentChild = null;
  let currentExeFile = null;
  socket.on('run-interactive', (data) => {
    const runHandler = (data) => {
      // Kill any existing process before starting a new one
      if (currentChild && !currentChild.killed) {
        try {
          currentChild.kill('SIGKILL');
          console.log('Killed previous process for socket:', socket.id);
        } catch (e) {
          console.error('Error killing previous process:', e.message);
        }
      }
      
      const id = data && data.id ? String(data.id) : '1';
      const rollNo = data && data.rollNo ? String(data.rollNo).trim() : null;
      console.log(`Run request: id=${id}, rollNo=${rollNo}`);
      
      let cppName = null;
      if (id === '1') cppName = 'overloading_1a.cpp';
      else if (id === '2') cppName = 'overloading_1b.cpp';
      const repoPath = idToRepoPath[id];
      const isWin = process.platform === 'win32';
      const unique = `${socket.id}_${Date.now()}`;
      const tempCpp = path.join(TEMP_DIR, `temp_${unique}.cpp`);
      const exeFile = path.join(TEMP_DIR, `exeCode_${socket.id}${isWin ? '.exe' : ''}`);
      currentExeFile = exeFile;
      const startCompileAndRun = (cppFilePath) => {
        const compileCmd = `g++ "${cppFilePath}" -o "${exeFile}"`;
        socket.emit('output', 'Compiling...\n');
        exec(compileCmd, { timeout: 20000 }, (compileErr, compileStdout, compileStderr) => {
          if (compileErr) {
            socket.emit('output', `Compilation failed:\n${compileStderr || compileErr.message}\n`);
            socket.emit('done');
            if (repoPath) fs.unlink(cppFilePath, () => {});
            return;
          }
          socket.emit('output', 'Compilation successful. Running...\n\n');
          // Notify client that compilation finished (used to trigger UI changes)
          try { socket.emit('compiled'); } catch (e) { /* ignore */ }
          let child;
          try {
            child = spawn(exeFile, [], { stdio: ['pipe', 'pipe', 'pipe'] });
            currentChild = child; // Store reference for stop handler
          } catch (err) {
            socket.emit('output', `Failed to start process: ${err.message}\n`);
            socket.emit('done');
            currentChild = null;
            fs.unlink(exeFile, () => {}); // Clean up
            if (repoPath) fs.unlink(cppFilePath, () => {});
            return;
          }
          let isRunning = true;
          child.stdout.on('data', (data) => {
            socket.emit('output', data.toString());
            resetInactivityTimer();
          });
          child.stderr.on('data', (data) => {
            socket.emit('output', data.toString());
            resetInactivityTimer();
          });
          const inputListener = (data) => {
            if (isRunning && child.stdin.writable) {
              child.stdin.write(data + '\n');
              resetInactivityTimer();
            }
          };
          socket.on('input', inputListener);
          const INACTIVITY_LIMIT_MS = 5 * 60 * 1000; // 5 minutes
          let inactivityTimer = null;
          const killChild = (reason) => {
            if (!isRunning) return;
            isRunning = false;
            try { child.kill(); } catch (e) {}
            socket.emit('output', `\n[Process killed: ${reason}]\n`);
            socket.emit('done');
          };
          const resetInactivityTimer = () => {
            if (inactivityTimer) clearTimeout(inactivityTimer);
            inactivityTimer = setTimeout(() => killChild('inactivity timeout'), INACTIVITY_LIMIT_MS);
          };
          resetInactivityTimer();
          const onDisconnect = () => {
            if (isRunning) {
              try { child.kill(); } catch (e) {}
            }
          };
          socket.on('disconnect', onDisconnect);
          child.on('close', (code, signal) => {
            isRunning = false;
            currentChild = null;
            if (inactivityTimer) clearTimeout(inactivityTimer);
            socket.off('input', inputListener);
            socket.off('disconnect', onDisconnect);
            socket.emit('output', `\n[Process exited with code ${code}]\n`);
            socket.emit('done');
            // Cleanup exe file with retry logic for Windows
            const cleanupExe = () => {
              fs.unlink(exeFile, (err) => {
                if (err) {
                  console.error(`Failed to delete ${exeFile}:`, err.message);
                  // Retry once after a delay (Windows may need time to release file)
                  setTimeout(() => {
                    fs.unlink(exeFile, (retryErr) => {
                      if (!retryErr) console.log(`Cleaned up ${exeFile} on retry`);
                    });
                  }, 1000);
                } else {
                  console.log(`Cleaned up ${exeFile}`);
                }
              });
            };
            cleanupExe();
            if (repoPath) fs.unlink(cppFilePath, () => {});
          });
          child.on('error', (err) => {
            isRunning = false;
            if (inactivityTimer) clearTimeout(inactivityTimer);
            socket.off('input', inputListener);
            socket.off('disconnect', onDisconnect);
            socket.emit('output', `\nProcess error: ${err.message}\n`);
            socket.emit('done');
            fs.unlink(exeFile, () => {}); // Clean up
            if (repoPath) fs.unlink(cppFilePath, () => {});
          });
        });
      };
      if (repoPath) {
        // Fetch from GitHub, customize, then write
        const url = GITHUB_RAW_BASE + repoPath;
        https.get(url, (res) => {
          if (res.statusCode !== 200) {
            socket.emit('output', `Failed to fetch source. \nCheck network & Refresh`);
            socket.emit('done');
            return;
          }
          let codeContent = '';
          res.on('data', (chunk) => { codeContent += chunk.toString(); });
          res.on('end', () => {
            // Customize code based on roll number
            const customizedCode = customizeCode(codeContent, rollNo);
            // Write customized code to temp file
            fs.writeFile(tempCpp, customizedCode, 'utf8', (err) => {
              if (err) {
                socket.emit('output', `Failed to write code file: ${err.message}\n`);
                socket.emit('done');
                return;
              }
              startCompileAndRun(tempCpp);
            });
          });
        }).on('error', (err) => {
          socket.emit('output', `Failed to fetch source: ${err.message}\n`);
          socket.emit('done');
        });
      } else {
        if (!cppName) {
          socket.emit('output', `Unknown id: ${id}. No mapping found and no local file fallback.\n`);
          socket.emit('done');
          return;
        }
        const cppFile = path.join(__dirname, cppName);
        // For local files, also customize if needed
        if (rollNo) {
          fs.readFile(cppFile, 'utf8', (err, codeContent) => {
            if (err) {
              socket.emit('output', `Failed to read local file: ${err.message}\n`);
              socket.emit('done');
              return;
            }
            const customizedCode = customizeCode(codeContent, rollNo);
            fs.writeFile(tempCpp, customizedCode, 'utf8', (writeErr) => {
              if (writeErr) {
                socket.emit('output', `Failed to write customized code: ${writeErr.message}\n`);
                socket.emit('done');
                return;
              }
              startCompileAndRun(tempCpp);
            });
          });
        } else {
          startCompileAndRun(cppFile);
        }
      }
    };
    runHandler(data);
  });
  
  // Handle stop request from client
  socket.on('stop', () => {
    console.log('Stop requested for socket:', socket.id);
    if (currentChild && !currentChild.killed) {
      try {
        currentChild.kill('SIGKILL'); // Force kill on Windows
        console.log('Killed process for socket:', socket.id);
        socket.emit('output', '\n[Execution stopped by user]\n');
        socket.emit('done');
        
        // Clean up exe file after killing process
        if (currentExeFile) {
          setTimeout(() => {
            fs.unlink(currentExeFile, (err) => {
              if (!err) console.log(`Cleaned up ${currentExeFile} after stop`);
            });
          }, 500);
        }
      } catch (e) {
        console.error('Error killing process:', e.message);
        socket.emit('output', '\n[Failed to stop process]\n');
        socket.emit('done');
      }
      currentChild = null;
    } else {
      socket.emit('output', '\n[No process running]\n');
      socket.emit('done');
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    // Clean up on disconnect
    if (currentChild && !currentChild.killed) {
      try {
        currentChild.kill('SIGKILL');
        console.log('Killed process on disconnect for socket:', socket.id);
      } catch (e) {
        console.error('Error killing process on disconnect:', e.message);
      }
    }
  });
});
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Set a different PORT environment variable or stop the process using this port.`);
    process.exit(1);
  }
  console.error('Server error:', err);
});
server.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on port ${port}`);
});

// Route for id/rollNo pattern (e.g., /1a/25lec07)
app.get('/:shortId/:rollNo', (req, res, next) => {
  const id = String(req.params.shortId || '');
  const rollNo = String(req.params.rollNo || '');
  // Avoid intercepting Socket.IO or dotted paths
  if (!id || id.includes('.') || id === 'socket.io' || !rollNo) return next();
  console.log(`Route /${id}/${rollNo} requested`);
  // Serve the app shell regardless of whether the id exists
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Short ID route: serve the UI shell for a single clean segment without dots
app.get('/:shortId', (req, res, next) => {
  const id = String(req.params.shortId || '');
  // Avoid intercepting Socket.IO, assets, or any dotted/segmented paths
  if (!id || id.includes('.') || id === 'socket.io') return next();
  const strict = /^(1|true|yes)$/i.test(String(process.env.STRICT_ID_ROUTING || ''));
  const exists = !!(idToRepoPath && Object.prototype.hasOwnProperty.call(idToRepoPath, id));
  if (!exists) {
    console.warn(`Route /${id} requested but not found in id-map.json. STRICT_ID_ROUTING=${strict ? 'ON' : 'OFF'}`);
  }
  if (strict && !exists) {
    return res.status(404).type('text').send(`Not found: /${id} doesn't exist`);
  }
  // Serve the app shell; the client will show a friendly not-found message if id is unknown
  res.sendFile(path.join(__dirname, 'index.html'));
});