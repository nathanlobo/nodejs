const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app); // Create the HTTP server
const io = socketIo(server); // Attach Socket.IO to it
const port = process.env.PORT || 3000; 

app.use(express.json());

// Serve the index.html file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Handle the interactive Socket.IO connections
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('run-interactive', () => {
    // Note: Using Linux-style commands for Render
    const cppFile = path.join(__dirname, 'overloading_1a.cpp');
    const exeFile = path.join(__dirname, 'exeCode_' + socket.id); // No .exe for Linux
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
        socket.emit('output', `\nProcess error: ${err.message}\n`);
        socket.emit('done');
        fs.unlink(exeFile, () => {}); // Clean up
      });

      // 30 second timeout for the running process
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

// VITAL CHANGE: Call .listen() on the 'server' object, not 'app'
// And listen on '0.0.0.0' for Render
server.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on port ${port}`);
});