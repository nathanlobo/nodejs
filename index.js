const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = 3000;
app.use(express.json());
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.post('/run', (req, res) => {
  const userInputRaw = typeof req.body.input === 'string' ? req.body.input : '';
  const userInput = userInputRaw.endsWith('\n') ? userInputRaw : userInputRaw + '\n';
  const cppFile = path.join(__dirname, 'overloading_1a.cpp');
  const exeFile = path.join(__dirname, 'exeCode.exe');
  const compileCmd = `g++ "${cppFile}" -o "${exeFile}"`;
  function cleanupExe() {
    fs.unlink(exeFile, (err) => {
      if (err) {
        console.error(`Failed to delete ${exeFile}:`, err.message);
      } else {
        console.log(`Successfully removed ${exeFile}`);
      }
    });
  }
  exec(compileCmd, { timeout: 20000 }, (compileErr, compileStdout, compileStderr) => {
    if (compileErr) {
      const out = `Compilation failed:\n${compileStderr || compileErr.message}`;
      res.json({ output: out });
      return;
    }
    let responded = false;
    try {
      const child = spawn(exeFile, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      function sendResponse(obj) {
        if (responded) return;
        responded = true;
        cleanupExe();
        res.json(obj);
      }
      if (userInput) {
        child.stdin.write(userInput);
      }
      child.stdin.end();
      const runtimeTimeout = 5000;
      const killTimer = setTimeout(() => {
        try { child.kill(); } catch (e) { /* ignore */ }
        sendResponse({ output: 'Error: Process timed out (5 seconds).\nYour C++ code may be waiting for more input or stuck in a loop.' });
      }, runtimeTimeout);

      child.on('error', (err) => {
        clearTimeout(killTimer);
        sendResponse({ output: `Failed to start process: ${err.message}` });
      });

      child.on('close', (code, signal) => {
        clearTimeout(killTimer);
        const combined = `---Program Output---\n${stdout}\n---Error Log (if any)---\n${stderr}\n(Exit code: ${code}, Signal: ${signal})`;
        sendResponse({ output: combined });
      });
    } catch (runErr) {
      console.error('Runtime error:', runErr);
      cleanupExe();
      res.json({ output: `Runtime error: ${runErr.message}` });
    }
  });
});
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('run-interactive', () => {
    const cppFile = path.join(__dirname, 'overloading_1a.cpp');
    const exeFile = path.join(__dirname, 'exeCode_' + socket.id + '.exe');
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
        fs.unlink(exeFile, () => {});
        return;
      }
      let isRunning = true;
      child.stdout.on('data', (data) => {
        socket.emit('output', data.toString());
      });
      child.stderr.on('data', (data) => {
        socket.emit('output', data.toString());
      });
      socket.on('input', (data) => {
        if (isRunning && child.stdin.writable) {
          child.stdin.write(data + '\n');
        }
      });
      child.on('close', (code, signal) => {
        isRunning = false;
        socket.emit('output', `\n[Process exited with code ${code}]\n`);
        socket.emit('done');
        fs.unlink(exeFile, (err) => {
          if (err) {
            console.error(`Failed to delete ${exeFile}:`, err.message);
          } else {
            console.log(`Cleaned up ${exeFile}`);
          }
        });
      });

      child.on('error', (err) => {
        isRunning = false;
        socket.emit('output', `\nProcess error: ${err.message}\n`);
        socket.emit('done');
        fs.unlink(exeFile, () => {});
      });
      setTimeout(() => {
        if (isRunning) {
          try { child.kill(); } catch (e) {}
          socket.emit('output', '\n[Process killed: 30 second timeout]\n');
          socket.emit('done');
        }
      }, 30000);
    });
  });
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});
server.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
  console.log('Make sure g++ is in your system PATH');
});