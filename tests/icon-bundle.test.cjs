/* Prevent unused vector-icon families from re-entering the Android bundle. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../src');
let directFeather = 0;
function scan(dir) {
  for (const ent of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, ent.name);
    if (ent.isDirectory()) scan(file);
    else if (/\.(ts|tsx)$/.test(ent.name)) {
      const text = fs.readFileSync(file, 'utf8');
      const barrel = /(?:from\s*|require\s*\(|import\s*\()\s*['"]@expo\/vector-icons['"]/;
      assert.ok(!barrel.test(text), `Use a direct icon-family import instead of the full barrel: ${file}`);
      directFeather += (text.match(/['"]@expo\/vector-icons\/Feather['"]/g) || []).length;
    }
  }
}
scan(root);
assert.ok(directFeather > 0, 'Feather is still explicitly imported');
console.log(`PASS icon imports avoid the full vector-icons barrel (${directFeather} direct Feather imports)`);
