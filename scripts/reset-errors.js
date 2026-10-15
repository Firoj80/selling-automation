const path = require('path');
try {
  console.log(JSON.stringify(require('../src/content/content-recovery').inspect(path.resolve(__dirname, '..')), null, 2));
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
