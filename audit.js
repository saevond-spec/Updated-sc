// audit.js – Full repository static audit
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ---- Configuration ----
const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'src');          // adjust if your source is elsewhere
const IGNORE = ['node_modules', '.git', 'logs', 'coverage', 'dist', 'build'];
const ENTRY_POINTS = ['src/app.js', 'index.js']; // files that are never imported but should be kept

// ---- Helpers ----
function getAllFiles(dir, fileList = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE.includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      getAllFiles(fullPath, fileList);
    } else {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

function isJSFile(file) {
  return /\.(js|mjs|cjs)$/.test(file);
}

function extractImports(fileContent) {
  const imports = [];
  const dynamicRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const staticRegex = /import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/g;
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const regex of [staticRegex, dynamicRegex, requireRegex]) {
    for (const m of fileContent.matchAll(regex)) {
      const module = m[1];
      if (module && !module.startsWith('node:')) {
        const type = module.startsWith('.') ? 'local' : 'npm';
        imports.push({ type, specifier: module });
      }
    }
  }
  return imports;
}

function resolveLocalImport(importPath, fileDir) {
  const absolute = path.resolve(fileDir, importPath);
  const possible = [absolute, absolute + '.js', absolute + '.mjs', path.join(absolute, 'index.js')];
  return possible.find(p => fs.existsSync(p)) || null;
}

function auditDependencies(packageJson) {
  return { ...packageJson.dependencies, ...packageJson.devDependencies };
}

// ---- Main audit ----
async function audit() {
  console.log('🔍 Starting static code audit...\n');

  // 1. Load package.json
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch (e) {
    console.error('❌ package.json missing or invalid');
    process.exit(1);
  }
  const declaredDeps = auditDependencies(pkg);

  // 2. Gather all JS files
  const allJSFiles = getAllFiles(ROOT).filter(isJSFile);
  const srcFiles = allJSFiles.filter(f => f.startsWith(SRC_DIR));
  const rootFiles = allJSFiles.filter(f => !f.startsWith(SRC_DIR) && f !== path.join(ROOT, 'audit.js'));
  console.log(`📁 Found ${allJSFiles.length} JS files (${srcFiles.length} in src/, ${rootFiles.length} in root).`);

  // 3. Analyze imports
  const issues = [];
  const importMap = new Map();    // file -> [resolved paths]
  const npmUsed = new Set();
  const missingLocal = [];

  for (const file of srcFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const imports = extractImports(content);
    const fileDir = path.dirname(file);

    for (const imp of imports) {
      if (imp.type === 'npm') {
        npmUsed.add(imp.specifier);
        if (!declaredDeps[imp.specifier]) {
          issues.push({
            file,
            severity: 'ERROR',
            message: `npm package "${imp.specifier}" imported but NOT in package.json`
          });
        }
      } else {
        // local import
        const resolved = resolveLocalImport(imp.specifier, fileDir);
        if (!resolved) {
          issues.push({
            file,
            severity: 'ERROR',
            message: `Local import "${imp.specifier}" cannot be resolved`
          });
          missingLocal.push({ file, specifier: imp.specifier });
        } else {
          if (!importMap.has(file)) importMap.set(file, []);
          importMap.get(file).push(resolved);
        }
      }
    }
  }

  // 4. Unused files (dead code)
  const importedFiles = new Set();
  for (const resolvedList of importMap.values()) {
    for (const r of resolvedList) importedFiles.add(r);
  }
  const unusedFiles = srcFiles.filter(f =>
    !importedFiles.has(f) && !ENTRY_POINTS.some(ep => f.endsWith(ep.replace('src/', '')))
  );

  // 5. Circular dependency check (simple DFS)
  const graph = new Map();
  for (const [file, deps] of importMap.entries()) {
    graph.set(file, deps);
  }
  const visited = new Set();
  const recStack = new Set();
  let circular = [];
  function dfs(node, path = []) {
    if (recStack.has(node)) {
      circular.push([...path, node]);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    recStack.add(node);
    const deps = graph.get(node) || [];
    for (const dep of deps) {
      dfs(dep, [...path, node]);
    }
    recStack.delete(node);
  }
  for (const file of graph.keys()) {
    if (!visited.has(file)) dfs(file);
  }

  // 6. Environment variables check
  let envVars = [];
  const envExample = path.join(ROOT, '.env.example');
  if (fs.existsSync(envExample)) {
    const content = fs.readFileSync(envExample, 'utf8');
    envVars = content.match(/^\s*([A-Z_]+)=/gm)?.map(m => m.trim().split('=')[0]) || [];
  }

  // 7. DeepSeek integration check
  const deepseekKey = envVars.includes('DEEPSEEK_API_KEY');
  const deepseekModel = envVars.includes('DEEPSEEK_MODEL_NAME');
  const deepseekImport = [...npmUsed].some(m => m.includes('deepseek'));
  if (!deepseekKey) issues.push({ file: '.env.example', severity: 'WARNING', message: 'DEEPSEEK_API_KEY not defined' });
  if (!deepseekModel) issues.push({ file: '.env.example', severity: 'INFO', message: 'DEEPSEEK_MODEL_NAME not defined, default will be used' });
  if (!deepseekImport) issues.push({ file: 'src/**', severity: 'INFO', message: 'No DeepSeek SDK import found (might be using raw fetch)' });

  // 8. Twitch integration check
  const twitchPackages = ['tmi.js', 'twitch', 'twurple', '@twurple/api', '@twurple/auth', '@twurple/eventsub'];
  const twitchUsed = [...npmUsed].some(m => twitchPackages.includes(m));
  if (!twitchUsed) issues.push({ file: 'package.json', severity: 'WARNING', message: 'No known Twitch library found (tmi.js, twurple, etc.)' });

  // 9. Build report
  const report = {
    totalFiles: allJSFiles.length,
    srcFiles: srcFiles.length,
    missingImports: missingLocal,
    npm: {
      used: [...npmUsed],
      declared: Object.keys(declaredDeps),
      missing: [...npmUsed].filter(p => !declaredDeps[p]),
    },
    unusedFiles,
    circularDependencies: circular.length > 0 ? circular : 'None',
    issues,
    envVars,
  };

  console.log('\n📊 Audit Report:\n');
  console.log(`   Total JS files: ${report.totalFiles}`);
  console.log(`   Source files: ${report.srcFiles}`);
  console.log(`   Missing local imports: ${report.missingImports.length}`);
  console.log(`   Unused files: ${report.unusedFiles.length}`);
  console.log(`   Circular dependencies: ${circular.length}`);
  console.log(`   Issues: ${issues.filter(i => i.severity === 'ERROR').length} errors, ${issues.filter(i => i.severity === 'WARNING').length} warnings`);

  if (report.missingImports.length) {
    console.log('\n❌ MISSING IMPORTS:');
    for (const mi of report.missingImports) {
      console.log(`   ${mi.file} → ${mi.specifier}`);
    }
  }

  if (report.unusedFiles.length) {
    console.log('\n📄 UNUSED FILES (possible dead code):');
    for (const f of report.unusedFiles) {
      console.log(`   ${f}`);
    }
  }

  if (circular.length) {
    console.log('\n🔄 CIRCULAR DEPENDENCIES:');
    for (const cycle of circular) {
      console.log(`   ${cycle.join(' → ')}`);
    }
  }

  if (report.npm.missing.length) {
    console.log('\n📦 MISSING NPM PACKAGES:');
    for (const p of report.npm.missing) {
      console.log(`   ${p} is imported but not in package.json`);
    }
  }

  // Print all issues
  if (issues.length) {
    console.log('\n⚠️  ALL ISSUES:');
    issues.forEach(({ file, severity, message }) => {
      console.log(`   [${severity}] ${file}: ${message}`);
    });
  }

  // Save to JSON
  fs.writeFileSync('audit-report.json', JSON.stringify(report, null, 2));
  console.log('\n✅ Full report saved to audit-report.json');
}

audit().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
