import { execFileSync } from 'node:child_process'

/**
 * 从上一次 tag 到本次 tag 的提交生成发布说明。
 * 提交遵循 Conventional Commits，按类型分组；无法解析的标题归到 Other。
 */
const tag = process.argv[2]
if (!tag) {
  console.error('usage: release-notes.mjs <tag>')
  process.exit(1)
}

// describe 在没有上一个 tag 时会失败，属于正常分支，不把 stderr 漏进发布说明
const git = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

const previousTag = () => {
  try {
    return git(['describe', '--tags', '--abbrev=0', `${tag}^`]).trim()
  } catch {
    return ''
  }
}

const groups = [
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactoring'],
  ['docs', 'Documentation'],
  ['build', 'Build'],
  ['ci', 'CI'],
  ['test', 'Tests'],
  ['style', 'Styles'],
  ['chore', 'Chores'],
  ['revert', 'Reverts'],
]
const buckets = new Map(groups.map(([type]) => [type, []]))
const other = []

const prev = previousTag()
const range = prev ? `${prev}..${tag}` : tag
const raw = git(['log', range, '--pretty=format:%h%x09%s%x1e'])

for (const record of raw.split('\x1e')) {
  const line = record.trim()
  if (!line) {
    continue
  }
  const [hash, subject] = line.split('\t')
  const match = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/.exec(subject ?? '')
  const entry = match
    ? `- ${match[2] ? `**${match[2]}:** ` : ''}${match[3]} (${hash})`
    : `- ${subject ?? ''} (${hash})`
  const bucket = match ? buckets.get(match[1]) : undefined
  if (bucket) {
    bucket.push(entry)
  } else {
    other.push(entry)
  }
}

const lines = []
for (const [type, title] of groups) {
  const items = buckets.get(type)
  if (!items || items.length === 0) {
    continue
  }
  lines.push(`### ${title}`, '', ...items, '')
}
if (other.length > 0) {
  lines.push('### Other', '', ...other, '')
}
if (prev) {
  lines.push(`**Full changelog:** https://github.com/${process.env.GITHUB_REPOSITORY ?? ''}/compare/${prev}...${tag}`)
}

process.stdout.write(`${lines.join('\n').trimEnd()}\n`)
