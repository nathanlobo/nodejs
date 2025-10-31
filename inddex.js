const express = require('express');
const app = express();
const port = 3000;

// This is the new important line!
// It tells Express to serve any files in the 'public' folder.
app.use(express.static('public'));

// We can remove the old app.get('/') route because
// Express will now automatically find and serve 'index.html'
// from the 'public' folder when someone visits '/'.

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}/`);
});