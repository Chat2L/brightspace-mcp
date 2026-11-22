# Brightspace MCP Server (D2L)

A free, open-source [MCP](https://modelcontextprotocol.io) server for Brightspace (D2L). Ask Claude, Cursor, Codex or any MCP app what's due, how your grades look, and what your profs posted.

It signs in with your own Brightspace session on your computer. No API key, no admin access, no password stored, and no server in the middle.

Built by [Chat2L](https://www.chat2l.com/?utm_source=github&utm_medium=readme&utm_campaign=brightspace-mcp).

## What you can ask

- "What's due this week across all my courses?"
- "Did I submit the COMM 341 case? What did the TA say?"
- "What's my grade in Investments so far, and what do I need on the final for a B+?"
- "Any new announcements since Friday?"
- "When does the next quiz open, and how long is it?"
- "List the week 9 readings for Operations."

## Tools

| Tool | What it returns |
| --- | --- |
| `list_courses` | Your courses with ids, codes and term dates |
| `list_upcoming` | Due dates, quiz windows and class events across every course, soonest first |
| `list_assignments` | Assignments with due dates, instructions, and your submission status, score and feedback |
| `get_grades` | Each grade item with points, weight and comments, plus category weights |
| `list_announcements` | Recent announcements from one course or all of them |
| `list_quizzes` | Quizzes with open, due and close times, time limits and attempts |
| `get_course_content` | The course's modules and files as an outline with links |

All tools are read-only. Nothing can be submitted, posted or changed.

## Setup

You need [Node.js](https://nodejs.org) 22 or newer, and Chrome, Edge, Brave or Chromium for signing in.

**1. Sign in once.** Use the address you open Brightspace at:

```bash
npx d2l-mcp login school.brightspace.com
```

A browser window opens at your school's normal sign-in page. Sign in the way you always do (SSO, Duo and other MFA all work). The window closes by itself once you're in.

**2. Add it to your AI app.**

Claude Code:

```bash
claude mcp add brightspace -- npx -y d2l-mcp
```

Codex:

```bash
codex mcp add brightspace -- npx -y d2l-mcp
```

Claude Desktop (Settings > Developer > Edit Config), Cursor (`~/.cursor/mcp.json`) and Windsurf (`~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "brightspace": {
      "command": "npx",
      "args": ["-y", "d2l-mcp"]
    }
  }
}
```

VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "brightspace": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "d2l-mcp"]
    }
  }
}
```

Restart the app, then ask "what's due this week?"

**Rather skip the terminal?** Add your school to the config and the first question opens the sign-in window:

```json
"brightspace": {
  "command": "npx",
  "args": ["-y", "d2l-mcp"],
  "env": { "BRIGHTSPACE_URL": "school.brightspace.com" }
}
```

## How sign-in works

- `login` opens a browser window with its own profile in `~/.d2l-mcp/browser`. Your everyday browser profile is never read.
- Once you're signed in, d2l-mcp reads the Brightspace cookies from that window, checks them with Brightspace, and saves them to `~/.d2l-mcp/session.json`. Only your user account can read that file.
- Your password goes to your school's own sign-in page. d2l-mcp never sees it.
- Brightspace sessions expire after some idle time (each school sets its own). When yours does, the next question opens the sign-in window again. Your school usually remembers you, so it often finishes on its own.
- `npx d2l-mcp status` shows who's signed in. `npx d2l-mcp logout` deletes the session and the window's profile.
- The window's profile keeps your school's sign-in cookies so it can sign you back in, encrypted the same way your browser stores them. `logout` deletes them.

No Chromium browser? Run `npx d2l-mcp login school.brightspace.com --cookie` and paste the `Cookie` header from any Brightspace API request in your browser's developer tools.

## Want answers from inside your lectures?

This server knows "Week 6 Lecture.pdf" exists. It can't read it.

[Chat2L](https://www.chat2l.com/claude-and-chatgpt?utm_source=github&utm_medium=readme&utm_campaign=brightspace-mcp) syncs your course files and connects them to ChatGPT and Claude. Ask "explain slide 14 from week 6" or "quiz me on the readings for Thursday" and get answers from your actual course material, with the file and page cited.

| | This server (free) | Chat2L |
| --- | --- | --- |
| Courses, due dates, grades, announcements, quizzes | Yes | Yes |
| Search inside lecture slides, PDFs and readings | No | Yes |
| Read a whole document or exact pages | No | Yes |
| Look at the slide itself (diagrams, charts, worked problems) | No | Yes |
| Answers cite the file and page | No | Yes |
| ChatGPT, and Claude on the web and phone | No (desktop apps only) | Yes |
| Brightspace, Canvas and Moodle | Brightspace only | Yes |
| Setup | Node.js and a terminal | Browser extension, no terminal |
| Where your data lives | Only your computer | Synced to Chat2L |

Plans and the free trial are on [chat2l.com](https://www.chat2l.com/?utm_source=github&utm_medium=readme&utm_campaign=brightspace-mcp).

## Privacy and security

- Read-only. It only makes GET requests.
- Your session cookies are sent to your school's Brightspace address and nowhere else.
- The sign-in window is controlled over a private pipe, not a network port, so other programs can't connect to it.
- No analytics or telemetry. There's no Chat2L server involved.
- Your AI app sees whatever Brightspace text it asks for, the same as anything else you paste into it.

## FAQ

**Is this allowed?** It makes the same read requests your browser makes when you use Brightspace, with your own login, and it can't change anything. If you're unsure, check your school's acceptable-use policy.

**Does it work at my school?** It should work at any school on Brightspace (D2L). It's tested on Queen's University's Brightspace. If it doesn't work at yours, [open an issue](https://github.com/Chat2L/brightspace-mcp/issues) with your Brightspace address.

**Does it work in ChatGPT?** ChatGPT only connects to hosted MCP servers, and this one runs on your computer. [Chat2L](https://www.chat2l.com/claude-and-chatgpt?utm_source=github&utm_medium=readme&utm_campaign=brightspace-mcp) works in ChatGPT.

**Where do the dates come from?** The Brightspace calendar and assignment settings, shown in your school's time zone.

## Development

```bash
pnpm install
pnpm test
pnpm build
node dist/cli.js --help
```

Files live in `~/.d2l-mcp` (set `D2L_MCP_HOME` to move them). Set `D2L_MCP_BROWSER` to use a specific Chromium browser.

## License

MIT
