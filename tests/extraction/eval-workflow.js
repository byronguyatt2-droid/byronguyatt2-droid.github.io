export const meta = {
  name: 'extraction-eval',
  description: 'Run SAYON\'s extraction prompt over the test transcripts with Sonnet subagents and score each answer against its answer key',
  whenToUse: 'Measuring a change to SYSTEM_PROMPT in js/app.js against tests/extraction/gold/',
  phases: [
    { title: 'Extract', detail: 'one Sonnet subagent per transcript per run, standing in for the app\'s model' },
    { title: 'Score', detail: 'score.mjs against each answer key' },
  ],
}

// args: { repo: absolute path to the repo checkout (required),
//         cases: ['house-test-1', 'house-test-2', ...] (default: the two real house tests),
//         runs: answers per case (default 3), tag: output folder name (default 'run'),
//         model: subagent model (default 'sonnet') }
// Writes answers to tests/extraction/out/<tag>/<case>-run<k>.json and
// returns score.mjs's report for each case.
const repo = args && args.repo
if (!repo) throw new Error('pass args.repo: the absolute path of the repo checkout')
const cases = (args.cases && args.cases.length) ? args.cases : ['house-test-1', 'house-test-2']
const runs = args.runs || 3
const tag = args.tag || 'run'
const model = args.model || 'sonnet'
const dir = `${repo}/tests/extraction`

const extractPrompt = (id, k) => `You are standing in for the AI model inside the SAYON app, which receives a system prompt and one user message and replies with JSON. Do exactly this and nothing else:
1. Read ${repo}/js/app.js and find the line starting \`const SYSTEM_PROMPT = \`\`. Everything from just after that opening backtick to the closing backtick is your system prompt. Read all of it.
2. Read ${dir}/transcripts/${id}.txt. That is the user's message: an inspector's dictated notes.
3. Answer exactly as the system prompt instructs, as if it were your only instruction.
4. Use the Write tool to save ONLY that answer (the raw JSON, no other text) to ${dir}/out/${tag}/${id}-run${k}.json.
Never open any other file. In particular never read anything under ${dir}/gold/, ${dir}/README.md or ${repo}/docs/: they hold the expected answers and reading them would spoil the test. Don't run commands. Reply with the path you wrote.`

const scorePrompt = (id) => `Run this command from ${repo} and reply with its full output, unchanged and nothing else:
node tests/extraction/score.mjs tests/extraction/gold/${id}.json ${Array.from({ length: runs }, (_, i) => `tests/extraction/out/${tag}/${id}-run${i + 1}.json`).join(' ')}`

const reports = await pipeline(
  cases,
  (id) => parallel(Array.from({ length: runs }, (_, i) => () =>
    agent(extractPrompt(id, i + 1), { label: `extract:${id}:${i + 1}`, phase: 'Extract', model }))),
  (_, id) => agent(scorePrompt(id), { label: `score:${id}`, phase: 'Score', model: 'haiku', effort: 'low' }),
)
return cases.map((id, i) => `## ${id}\n${reports[i] || '(scoring failed)'}`).join('\n\n')
