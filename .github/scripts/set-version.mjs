import { readFileSync, writeFileSync } from 'node:fs'

/**
 * 把 tag 里的版本号写进三处清单，保证安装包、窗口版本与 Cargo 一致。
 * 只改各自的第一处 version 字段，不碰依赖版本。
 */
const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`invalid version: ${version ?? '(empty)'}`)
  process.exit(1)
}

const rewrite = (path, pattern) => {
  const before = readFileSync(path, 'utf8')
  const after = before.replace(pattern, (_, head, _current, tail) => `${head}${version}${tail}`)
  if (after === before) {
    console.error(`no version field found in ${path}`)
    process.exit(1)
  }
  writeFileSync(path, after)
}

rewrite('package.json', /("version"\s*:\s*")([^"]*)(")/)
rewrite('src-tauri/tauri.conf.json', /("version"\s*:\s*")([^"]*)(")/)
rewrite('src-tauri/Cargo.toml', /^(version\s*=\s*")([^"]*)(")/m)

console.log(`version -> ${version}`)
