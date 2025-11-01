const express = require('express');
const { exec, spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app); // Create the HTTP server
const io = socketIo(server); // Attach Socket.IO to it
const port = process.env.PORT || 3000; 

app.use(express.json());
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/run', (req, res) => {
  const id = String(req.query.id || '1');
  let cppName;
  if (id === '1') cppName = 'overloading_1a.cpp';
  else if (id === '2') cppName = 'overloading_1b.cpp';
  else {
    return res.status(400).type('text').send('Invalid id. Use id=1 or id=2');
  }

  const cppFile = path.join(__dirname, cppName);
  // On Windows we need the .exe extension so the OS can run the file directly.
  const isWin = process.platform === 'win32';
  const exeBase = `exe_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const exeFile = path.join(__dirname, isWin ? `${exeBase}.exe` : exeBase);
  const compileCmd = `g++ "${cppFile}" -o "${exeFile}"`;

  // Compile
  exec(compileCmd, { timeout: 20000 }, (compileErr, compileStdout, compileStderr) => {
    if (compileErr) {
      res.type('text').status(500).send(`Compilation failed:\n${compileStderr || compileErr.message}`);
      return;
    }

    // Run the generated executable (limited to 30s)
    // Allow optional input via query (?input=...) or JSON body { input: '...' }
    const providedInput = (req.query && req.query.input) || (req.body && req.body.input) || '';

    // Use spawn so we can write to stdin if input is provided, and manage timeout
    const child = spawn(exeFile, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let errOut = '';
    let killedByTimeout = false;

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { errOut += d.toString(); });

    // If input provided, write it and close stdin. If not provided, leave stdin open
    // (some programs may read until EOF; leaving open can still cause a timeout).
    if (providedInput) {
      try {
        child.stdin.write(String(providedInput));
      } catch (e) {
        // ignore
      }
      try { child.stdin.end(); } catch (e) {}
    }

    // 30s timeout
    const killTimer = setTimeout(() => {
      killedByTimeout = true;
      try { child.kill(); } catch (e) {}
    }, 30000);

    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      // Clean up exe
      fs.unlink(exeFile, () => {});

      let body = out || '';
      if (errOut) body += `\nSTDERR:\n${errOut}`;
      if (killedByTimeout) body += `\n[Process was killed (timeout or signal)]`;
      if (code !== null && code !== undefined) body += `\n[Exit code: ${code}]`;

      res.type('text').status(200).send(body || '[No output]');
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      fs.unlink(exeFile, () => {});
      const body = `Process error: ${err.message}`;
      res.type('text').status(200).send(body);
    });
  });
});

// Handle the interactive Socket.IO connections
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('run-interactive', (data) => {
    // data may contain an { id } when the client provided it
    // (so visiting /?id=2 and clicking Run will run the second file).
    const runHandler = (data) => {
      const id = data && data.id ? String(data.id) : '1';
      let cppName;
      if (id === '1') cppName = 'overloading_1a.cpp';
      else if (id === '2') cppName = 'overloading_1b.cpp';
      else cppName = 'overloading_1a.cpp';

      const cppFile = path.join(__dirname, cppName);
      const isWin = process.platform === 'win32';
      const exeFile = path.join(__dirname, `exeCode_${socket.id}${isWin ? '.exe' : ''}`);
      const compileCmd = `g++ "${cppFile}" -o "${exeFile}"`;

      socket.emit('output', 'Compiling...\n');
      exec(compileCmd, { timeout: 20000 }, (compileErr, compileStdout, compileStderr) => {
        if (compileErr) {
          socket.emit('output', `Compilation failed:\n${compileStderr || compileErr.message}\n`);
          socket.emit('done');
          return;
        }

        socket.emit('output', 'Compilation successful. Running...\n\n');
        let child;
        try {
          child = spawn(exeFile, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (err) {
          socket.emit('output', `Failed to start process: ${err.message}\n`);
          socket.emit('done');
          fs.unlink(exeFile, () => {}); // Clean up
          return;
        }

        let isRunning = true;
        // Relay stdout/stderr to the client and reset inactivity timer on activity
        child.stdout.on('data', (data) => {
          socket.emit('output', data.toString());
          resetInactivityTimer();
        });

        child.stderr.on('data', (data) => {
          socket.emit('output', data.toString());
          resetInactivityTimer();
        });

        // Input listener (remove when process ends)
        const inputListener = (data) => {
          if (isRunning && child.stdin.writable) {
            child.stdin.write(data + '\n');
            resetInactivityTimer();
          }
        };
        socket.on('input', inputListener);

        // Inactivity timer: give the user plenty of time to type.
        // Reset whenever stdout/stderr arrives or the user sends input.
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
        // Start the timer
        resetInactivityTimer();

        // If the socket disconnects, terminate the child process
        const onDisconnect = () => {
          if (isRunning) {
            try { child.kill(); } catch (e) {}
          }
        };
        socket.on('disconnect', onDisconnect);

        child.on('close', (code, signal) => {
          isRunning = false;
          if (inactivityTimer) clearTimeout(inactivityTimer);
          socket.off('input', inputListener);
          socket.off('disconnect', onDisconnect);
          socket.emit('output', `\n[Process exited with code ${code}]\n`);
          socket.emit('done');
          fs.unlink(exeFile, (err) => { // Clean up
            if (err) {
              console.error(`Failed to delete ${exeFile}:`, err.message);
            } else {
              console.log(`Cleaned up ${exeFile}`);
            }
          });
        });

        child.on('error', (err) => {
          isRunning = false;
          if (inactivityTimer) clearTimeout(inactivityTimer);
          socket.off('input', inputListener);
          socket.off('disconnect', onDisconnect);
          socket.emit('output', `\nProcess error: ${err.message}\n`);
          socket.emit('done');
          fs.unlink(exeFile, () => {}); // Clean up
        });
      });
    };

    // Support both forms: socket.emit('run-interactive') and
    // socket.emit('run-interactive', { id: '2' })
    // The 'socket.on' callback receives the optional data param.
    runHandler(data);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// VITAL CHANGE: Call .listen() on the 'server' object, not 'app'
// And listen on '0.0.0.0' for Render
server.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on port ${port}`);
});