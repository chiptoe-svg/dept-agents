/**
 * Agent export — Phase 5.
 *
 * GET /api/drafts/:folder/export returns a zip containing five format
 * subfolders (claude / openai / gemini / openclaw / universal) plus
 * WHAT-I-BUILT.md and a top-level README. Class takeaway for students
 * who want to re-deploy their agent after the course.
 *
 * Design: docs/superpowers/specs/2026-05-21-agent-export-design.md
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import JSZip from 'jszip';

import { CONTAINER_DIR, GROUPS_DIR } from '../../../config.js';
import { getAgentGroupByFolder } from '../../../db/agent-groups.js';
import { canReadDraft } from '../draft-read-gate.js';
import { listCustomSkills, listCustomSkillFiles, readCustomSkillFile } from '../custom-skills.js';
import { aggregateAgentUsage } from './usage.js';
import { entryDir } from './agent-library.js';

// ── Types ─────────────────────────────────────────────────────────────────

export interface BuiltinSkillEntry {
  name: string;
  description: string;
  body: string;
}

export interface CustomSkillEntry {
  name: string;
  description: string;
  files: Record<string, string>; // relPath → content
}

export interface AgentSources {
  folder: string;
  assistantName: string;
  provider: string;
  model: string;
  claudeMd: string;
  claudeLocalMd: string | null;
  builtinSkills: BuiltinSkillEntry[];
  customSkills: CustomSkillEntry[];
  mcpServers: Record<string, unknown>;
}

interface ContainerJson {
  assistantName?: string;
  provider?: string;
  model?: string;
  skills?: string[] | 'all';
  mcpServers?: Record<string, unknown>;
  packages?: unknown;
  agentGroupId?: string;
}

// ── Phase A: source assembler ─────────────────────────────────────────────

const BUILTIN_SKILLS_DIR = path.join(CONTAINER_DIR, 'skills');

function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!pair) continue;
    let v = pair[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[pair[1]!] = v;
  }
  return out;
}

function readBuiltinSkill(name: string): BuiltinSkillEntry | null {
  const skillMd = path.join(BUILTIN_SKILLS_DIR, name, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return null;
  const body = fs.readFileSync(skillMd, 'utf-8');
  const fm = parseFrontmatter(body);
  return { name: fm.name ?? name, description: fm.description ?? '', body };
}

function collectFiles(baseDir: string, dir: string, out: Record<string, string>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      collectFiles(baseDir, fullPath, out);
    } else {
      try {
        out[relPath] = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        /* skip */
      }
    }
  }
}

export function readAgentSources(folder: string, rootDirOverride?: string): AgentSources | null {
  const groupDir = rootDirOverride ?? path.join(GROUPS_DIR, folder);
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) return null;

  const claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');

  const localMdPath = path.join(groupDir, 'CLAUDE.local.md');
  const claudeLocalMd = fs.existsSync(localMdPath) ? fs.readFileSync(localMdPath, 'utf-8') : null;

  let containerJson: ContainerJson = {};
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    try {
      containerJson = JSON.parse(fs.readFileSync(containerJsonPath, 'utf-8')) as ContainerJson;
    } catch {
      // malformed — use defaults
    }
  }

  const skillNames = Array.isArray(containerJson.skills) ? containerJson.skills : [];
  const builtinSkills: BuiltinSkillEntry[] = [];
  for (const name of skillNames) {
    const entry = readBuiltinSkill(name);
    if (entry) builtinSkills.push(entry);
  }

  let customSkills: CustomSkillEntry[];
  if (rootDirOverride !== undefined) {
    // Read custom skills directly from the directory (used for library entries)
    const customSkillsDir = path.join(groupDir, 'custom-skills');
    customSkills = [];
    if (fs.existsSync(customSkillsDir)) {
      for (const dirent of fs.readdirSync(customSkillsDir, { withFileTypes: true })) {
        if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
        const skillName = dirent.name;
        const skillDir = path.join(customSkillsDir, skillName);
        // Read SKILL.md for frontmatter (description)
        const skillMdPath = path.join(skillDir, 'SKILL.md');
        let description = '';
        if (fs.existsSync(skillMdPath)) {
          const fm = parseFrontmatter(fs.readFileSync(skillMdPath, 'utf-8'));
          description = fm.description ?? '';
        }
        // Collect all files recursively
        const files: Record<string, string> = {};
        collectFiles(skillDir, skillDir, files);
        customSkills.push({ name: skillName, description, files });
      }
    }
  } else {
    customSkills = [];
    const customSkillMetas = listCustomSkills(folder);
    for (const meta of customSkillMetas) {
      const fileList = listCustomSkillFiles(folder, meta.name);
      const files: Record<string, string> = {};
      for (const f of fileList) {
        if (f.isDir) continue;
        const content = readCustomSkillFile(folder, meta.name, f.path);
        if (content !== undefined) files[f.path] = content;
      }
      customSkills.push({ name: meta.name, description: meta.description, files });
    }
  }

  return {
    folder,
    assistantName: containerJson.assistantName ?? folder,
    provider: containerJson.provider ?? 'claude',
    model: containerJson.model ?? '',
    claudeMd,
    claudeLocalMd: claudeLocalMd?.trim() ? claudeLocalMd : null,
    builtinSkills,
    customSkills,
    mcpServers: containerJson.mcpServers ?? {},
  };
}

// ── Phase B: WHAT-I-BUILT generator ───────────────────────────────────────

function firstParagraph(md: string): string {
  // Strip YAML frontmatter if present, then return first non-empty paragraph.
  const stripped = md.replace(/^---[\s\S]*?---\n/, '').trim();
  const para = stripped.split(/\n\n+/)[0] ?? '';
  return para
    .replace(/^#+\s+/gm, '')
    .trim()
    .slice(0, 500);
}

function descriptionFirstSentence(desc: string): string {
  const m = desc.match(/^[^.!?]+[.!?]/);
  return m ? m[0] : desc.slice(0, 80);
}

export function generateWhatIBuilt(
  sources: AgentSources,
  usage: {
    thisMonth: { costUsd: number; tokensIn: number; tokensOut: number };
    total: { costUsd: number; tokensIn: number; tokensOut: number };
  } | null,
): string {
  const builtinNames = sources.builtinSkills.map((s) => s.name).join(', ') || '(none)';
  const customNames = sources.customSkills.map((s) => s.name).join(', ') || '(none)';

  const allSkills = [
    ...sources.builtinSkills.map((s) => `- **${s.name}** — ${descriptionFirstSentence(s.description)}`),
    ...sources.customSkills.map(
      (s) => `- **${s.name}** *(custom — you built this)* — ${descriptionFirstSentence(s.description)}`,
    ),
  ];

  const usageLines = usage
    ? [
        `**Total tokens:** ${(usage.total.tokensIn + usage.total.tokensOut).toLocaleString()} (in + out)`,
        `**Total cost:** $${usage.total.costUsd.toFixed(4)} since first session`,
        `**This month:** $${usage.thisMonth.costUsd.toFixed(4)}`,
      ].join('\n')
    : '_Usage data unavailable._';

  const about = firstParagraph(sources.claudeMd);

  const lines = [
    `# What I Built — ${sources.assistantName}`,
    '',
    `**Model used:** ${sources.provider}/${sources.model || '(default)'}`,
    `**Built-in skills:** ${builtinNames}`,
    `**Custom skills:** ${customNames}`,
    usageLines,
    '',
    '## What my agent can do',
    '',
    allSkills.length > 0 ? allSkills.join('\n') : '_No skills activated._',
    '',
    '## About the agent',
    '',
    about || '_No persona description found._',
    '',
    '---',
    '_Exported from NanoClaw Agent Playground._',
  ];
  return lines.join('\n');
}

// ── Phase C: bundle generators ────────────────────────────────────────────

function skillsEntry(prefix: string, skills: BuiltinSkillEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of skills) {
    out[`${prefix}/skills/${s.name}/SKILL.md`] = s.body;
  }
  return out;
}

function customSkillsEntry(prefix: string, skills: CustomSkillEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of skills) {
    for (const [relPath, content] of Object.entries(s.files)) {
      out[`${prefix}/custom-skills/${s.name}/${relPath}`] = content;
    }
  }
  return out;
}

function toolsSection(builtins: BuiltinSkillEntry[], customs: CustomSkillEntry[]): string {
  if (builtins.length === 0 && customs.length === 0) return '';
  const lines = ['\n\n## Available tools\n'];
  for (const s of builtins) {
    lines.push(`- **${s.name}** — ${descriptionFirstSentence(s.description)}`);
  }
  for (const s of customs) {
    lines.push(`- **${s.name}** [custom] — ${descriptionFirstSentence(s.description)}`);
  }
  return lines.join('\n');
}

// ── READMEs ──────────────────────────────────────────────────────────────

function readmeTop(s: AgentSources): string {
  return [
    `# ${s.assistantName} — Agent Export`,
    '',
    'Your NanoClaw Agent Playground agent, exported for use in other tools.',
    '',
    '## Which folder to use',
    '',
    '| Folder | Use when you have… |',
    '|---|---|',
    '| `claude/` | Claude Code (`claude` CLI) |',
    '| `openai/` | OpenAI Codex CLI (`codex` CLI) |',
    '| `gemini/` | Google Gemini CLI (`gemini` CLI) |',
    '| `openclaw/` | A self-hosted NanoClaw instance |',
    '| `universal/` | ChatGPT custom instructions, Cursor, or any other tool |',
    '',
    'Start with `WHAT-I-BUILT.md` for a summary of what your agent does.',
  ].join('\n');
}

function readmeClaude(s: AgentSources): string {
  const hasCustom = s.customSkills.length > 0;
  return [
    '# Using your agent with Claude Code',
    '',
    '## Install Claude Code',
    '```',
    'npm install -g @anthropic-ai/claude-code',
    'claude /login',
    '```',
    '',
    '## Place the files',
    '',
    '**Persona** — drop `CLAUDE.md` in your project root (or `~/.claude/CLAUDE.md` for a global agent):',
    '```',
    'cp CLAUDE.md /path/to/your/project/',
    '```',
    '',
    ...(s.claudeLocalMd ? ['**Memory** — drop `CLAUDE.local.md` alongside `CLAUDE.md`:', ''] : []),
    '**Built-in skills** — copy to `~/.claude/skills/`:',
    '```',
    'cp -r skills/* ~/.claude/skills/',
    '```',
    ...(hasCustom
      ? [
          '',
          '**Custom skills (your own)** — copy to the same place (they override any built-in with the same name):',
          '```',
          'cp -r custom-skills/* ~/.claude/skills/',
          '```',
        ]
      : []),
    '',
    '## Run',
    '```',
    'cd /path/to/your/project',
    'claude',
    '```',
    '',
    'Your agent will introduce itself and be ready to help.',
  ].join('\n');
}

function readmeOpenAI(s: AgentSources): string {
  const hasMcp = Object.keys(s.mcpServers).length > 0;
  const hasCustom = s.customSkills.length > 0;
  return [
    '# Using your agent with OpenAI Codex CLI',
    '',
    '## Install Codex',
    '```',
    'npm install -g @openai/codex',
    'codex login',
    '```',
    '',
    '## Place the files',
    '',
    '**Persona** — `CLAUDE.md` in your project root (Codex reads this natively):',
    '```',
    'cp CLAUDE.md /path/to/your/project/',
    '```',
    '',
    '**Skills** — copy to `~/.claude/skills/` (Codex uses the same path):',
    '```',
    'cp -r skills/* ~/.claude/skills/',
    '```',
    ...(hasCustom
      ? ['', '**Custom skills** — same destination:', '```', 'cp -r custom-skills/* ~/.claude/skills/', '```']
      : []),
    ...(hasMcp
      ? ['', '**MCP servers** — append the contents of `config-snippet.toml` to `~/.codex/config.toml`.']
      : []),
    '',
    '## Run',
    '```',
    'cd /path/to/your/project',
    'codex',
    '```',
  ].join('\n');
}

function readmeGemini(): string {
  return [
    '# Using your agent with Gemini CLI',
    '',
    '## Install Gemini CLI',
    'Follow the install guide at https://github.com/google-gemini/gemini-cli',
    '',
    '## Place the files',
    '',
    '**Persona + tools** — drop `GEMINI.md` in your project root:',
    '```',
    'cp GEMINI.md /path/to/your/project/',
    '```',
    '',
    'The `## Available tools` section at the bottom of `GEMINI.md` describes',
    "your agent's capabilities. Gemini CLI does not have a native skill-invocation",
    'mechanism — the descriptions give the model context about what you can do.',
    '',
    '## Run',
    '```',
    'cd /path/to/your/project',
    'gemini',
    '```',
  ].join('\n');
}

function readmeOpenClaw(s: AgentSources): string {
  return [
    '# Using your agent with a self-hosted NanoClaw',
    '',
    '## Set up NanoClaw',
    'Follow the install guide at https://github.com/qwibitai/nanoclaw',
    '',
    '## Copy your agent',
    '```',
    `cp -r . /path/to/nanoclaw/groups/${s.folder}/`,
    '```',
    '',
    '## Create the agent group',
    '```',
    `ncl groups create --folder ${s.folder} --provider ${s.provider} --model "${s.model}"`,
    '```',
    '',
    '## Wire a messaging group and restart',
    '```',
    `ncl messaging-groups create --name "${s.assistantName}"`,
    `ncl wirings create --agent-group ${s.folder} --messaging-group <id>`,
    'launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS',
    '# systemctl --user restart nanoclaw               # Linux',
    '```',
    '',
    'Your agent will be reachable on whichever channel you wired.',
  ].join('\n');
}

function readmeUniversal(): string {
  return [
    '# Using your agent anywhere',
    '',
    'The `agent.md` file in this folder is a portable description of your agent.',
    'It has three sections: **Instructions**, **Memory**, and **Skills**.',
    '',
    '## ChatGPT custom instructions',
    'Copy the **Instructions** section into Settings → Personalization → Custom instructions.',
    '',
    '## Cursor',
    'Rename `agent.md` to `.cursorrules` and drop it in your project root.',
    '',
    '## Any other LLM tool',
    'Paste the **Instructions** section as the system prompt.',
    '',
    '## Copy to a new tool later',
    'This file travels with you — keep it wherever you store your notes.',
  ].join('\n');
}

// ── Bundle builders ───────────────────────────────────────────────────────

export function buildClaudeBundle(s: AgentSources): Record<string, string> {
  const files: Record<string, string> = {
    'claude/README.md': readmeClaude(s),
    'claude/CLAUDE.md': s.claudeMd,
    ...skillsEntry('claude', s.builtinSkills),
    ...customSkillsEntry('claude', s.customSkills),
  };
  if (s.claudeLocalMd) files['claude/CLAUDE.local.md'] = s.claudeLocalMd;
  return files;
}

export function buildOpenAIBundle(s: AgentSources): Record<string, string> {
  const files: Record<string, string> = {
    'openai/README.md': readmeOpenAI(s),
    'openai/CLAUDE.md': s.claudeMd,
    ...skillsEntry('openai', s.builtinSkills),
    ...customSkillsEntry('openai', s.customSkills),
  };
  if (s.claudeLocalMd) files['openai/CLAUDE.local.md'] = s.claudeLocalMd;
  const mcpEntries = Object.entries(s.mcpServers);
  if (mcpEntries.length > 0) {
    const lines = ['[model_providers.openai-custom.mcp_servers]'];
    for (const [name, cfg] of mcpEntries) {
      lines.push(`[model_providers.openai-custom.mcp_servers.${name}]`);
      lines.push(`# ${JSON.stringify(cfg)}`);
    }
    files['openai/config-snippet.toml'] = lines.join('\n') + '\n';
  }
  return files;
}

export function buildGeminiBundle(s: AgentSources): Record<string, string> {
  const files: Record<string, string> = {
    'gemini/README.md': readmeGemini(),
    'gemini/GEMINI.md': s.claudeMd + toolsSection(s.builtinSkills, s.customSkills),
  };
  if (s.claudeLocalMd) files['gemini/GEMINI.local.md'] = s.claudeLocalMd;
  return files;
}

export function buildOpenClawBundle(s: AgentSources): Record<string, string> {
  // Clean container.json: remove host-specific fields
  const cleanContainer = {
    provider: s.provider,
    model: s.model,
    skills: s.builtinSkills.map((sk) => sk.name),
    mcpServers: s.mcpServers,
  };
  const files: Record<string, string> = {
    'openclaw/README.md': readmeOpenClaw(s),
    'openclaw/CLAUDE.md': s.claudeMd,
    'openclaw/container.json': JSON.stringify(cleanContainer, null, 2) + '\n',
    ...skillsEntry('openclaw', s.builtinSkills),
    ...customSkillsEntry('openclaw', s.customSkills),
  };
  if (s.claudeLocalMd) files['openclaw/CLAUDE.local.md'] = s.claudeLocalMd;
  return files;
}

export function buildUniversalBundle(s: AgentSources): Record<string, string> {
  const skillBullets = [
    ...s.builtinSkills.map((sk) => `- **${sk.name}** — ${descriptionFirstSentence(sk.description)}`),
    ...s.customSkills.map(
      (sk) => `- **${sk.name}** *(custom — you built this)* — ${descriptionFirstSentence(sk.description)}`,
    ),
  ];
  const agentMd = [
    `# ${s.assistantName} — Agent Export`,
    '',
    '## Instructions',
    '',
    s.claudeMd,
    '',
    '## Memory',
    '',
    s.claudeLocalMd ?? '_(no memory recorded)_',
    '',
    '## Skills',
    '',
    skillBullets.length > 0 ? skillBullets.join('\n') : '_No skills activated._',
  ].join('\n');

  return {
    'universal/README.md': readmeUniversal(),
    'universal/agent.md': agentMd,
  };
}

// ── Phase D: zip assembly + HTTP handler ─────────────────────────────────

export async function buildExportZip(sources: AgentSources, whatIBuilt: string, _format: string): Promise<Buffer> {
  const zip = new JSZip();

  zip.file('README.md', readmeTop(sources));
  zip.file('WHAT-I-BUILT.md', whatIBuilt);

  const bundles = [
    buildClaudeBundle(sources),
    buildOpenAIBundle(sources),
    buildGeminiBundle(sources),
    buildOpenClawBundle(sources),
    buildUniversalBundle(sources),
  ];

  for (const bundle of bundles) {
    for (const [filePath, content] of Object.entries(bundle)) {
      zip.file(filePath, content);
    }
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

interface ExportSuccess {
  buffer: Buffer;
  filename: string;
}

export async function handleExport(
  folder: string,
  userId: string | null | undefined,
  format: string,
): Promise<ExportSuccess | { status: number; error: string }> {
  if (!canReadDraft(folder, userId)) {
    return { status: 403, error: 'Forbidden' };
  }

  const group = getAgentGroupByFolder(folder);
  if (!group) return { status: 404, error: `no agent group for folder ${folder}` };

  const sources = readAgentSources(folder);
  if (!sources) return { status: 404, error: `CLAUDE.md not found for folder ${folder}` };

  let usage: {
    thisMonth: { costUsd: number; tokensIn: number; tokensOut: number };
    total: { costUsd: number; tokensIn: number; tokensOut: number };
  } | null = null;
  try {
    const u = aggregateAgentUsage(group.id);
    usage = {
      thisMonth: { costUsd: u.thisMonth.costUsd, tokensIn: u.thisMonth.tokensIn, tokensOut: u.thisMonth.tokensOut },
      total: { costUsd: u.total.costUsd, tokensIn: u.total.tokensIn, tokensOut: u.total.tokensOut },
    };
  } catch {
    // non-fatal — zip still ships without usage data
  }

  const whatIBuilt = generateWhatIBuilt(sources, usage);

  try {
    const buffer = await buildExportZip(sources, whatIBuilt, format);
    // Safe filename: folder name stripped of anything that isn't alnum/hyphen/underscore
    const safeName = folder.replace(/[^A-Za-z0-9_-]/g, '-');
    return { buffer, filename: `${safeName}-export.zip` };
  } catch (err) {
    return { status: 500, error: `zip assembly failed: ${(err as Error).message}` };
  }
}

export async function handleLibraryEntryExport(
  folder: string,
  slug: string,
  userId: string | null | undefined,
  format: string,
): Promise<{ buffer: Buffer; filename: string } | { status: number; error: string }> {
  if (!canReadDraft(folder, userId)) return { status: 403, error: 'Forbidden' };
  const group = getAgentGroupByFolder(folder);
  if (!group) return { status: 404, error: `no agent group for folder ${folder}` };
  const libraryEntryDir = entryDir(folder, slug);
  if (!fs.existsSync(libraryEntryDir)) return { status: 404, error: `Library entry "${slug}" not found` };

  const sources = readAgentSources(folder, libraryEntryDir);
  if (!sources) return { status: 404, error: `CLAUDE.md not found for library entry "${slug}"` };

  let usage = null;
  try {
    const u = aggregateAgentUsage(group.id);
    usage = {
      thisMonth: { costUsd: u.thisMonth.costUsd, tokensIn: u.thisMonth.tokensIn, tokensOut: u.thisMonth.tokensOut },
      total: { costUsd: u.total.costUsd, tokensIn: u.total.tokensIn, tokensOut: u.total.tokensOut },
    };
  } catch {
    /* non-fatal */
  }

  const whatIBuilt = generateWhatIBuilt(sources, usage);
  try {
    const buffer = await buildExportZip(sources, whatIBuilt, format);
    const safeName = folder.replace(/[^A-Za-z0-9_-]/g, '-');
    const safeSlug = slug.replace(/[^A-Za-z0-9_-]/g, '-');
    return { buffer, filename: `${safeName}-${safeSlug}-export.zip` };
  } catch (err) {
    return { status: 500, error: `zip assembly failed: ${(err as Error).message}` };
  }
}

// Suppress unused import warning — crypto is used for future dirty-detection
// helpers that share this module; keep it available.
void crypto;
