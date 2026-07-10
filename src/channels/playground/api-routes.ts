/**
 * Playground REST + SSE routes.
 *
 * Single dispatch entry point: `route(req, res, url, method, session)`.
 * Returns 404 on no match. Each `/api/...` endpoint matches inline; the
 * file is long because the surface is wide, not because the dispatch
 * logic is complex.
 *
 * Mutation gates (file PUT, skills PUT, provider PUT) consult
 * `playground-gate-registry.checkDraftMutation` with the calling
 * session's `userId` so the class feature can lock students down to
 * persona edits without this file knowing anything about the class
 * feature.
 *
 * Every `/api/drafts/:folder` GET route consults `canReadDraft` so an
 * authenticated user cannot read another agent group's persona, skill
 * list, or custom-skill files by guessing the folder name.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';

import {
  applyDraft,
  createDraft,
  discardDraft,
  ensureDraftMessagingGroup,
  ensureDraftWiring,
  listAgentGroups,
  listDrafts,
} from '../../agent-builder/core.js';
import { GROUPS_DIR } from '../../config.js';
import { processImage } from '../../image.js';
import { materializeContainerJson } from '../../container-config.js';
import { updateContainerConfigJson } from '../../db/container-configs.js';
import { isContainerRunning, killContainer } from '../../container-runner.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getActiveSessions } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../adapter.js';
import { checkDraftMutation } from '../playground-gate-registry.js';
import { canReadDraft } from './draft-read-gate.js';
import { requireGroupAccess } from './require-group-access.js';
import { getPlatformPrefix, getSetupConfig, playgroundOutboxDir } from './adapter.js';
import { isSafeAttachmentName } from '../../attachment-safety.js';

// Minimal content-type lookup for agent-produced files. The chat tab renders
// these as `<a download>` links so the browser only needs the type as a hint.
function contentTypeFor(filename: string): string {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  switch (ext) {
    case '.md':
      return 'text/markdown; charset=utf-8';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.csv':
      return 'text/csv; charset=utf-8';
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}
import type { PlaygroundSession } from './auth-store.js';
import { readJsonBody, readRawBody, send } from './http-helpers.js';
import {
  handleListCorpora,
  handleCreateCorpus,
  handleDeleteCorpus,
  handleGetCorpus,
  handleUploadSource,
  handleIngest,
  handleInspect,
  handleQuery,
} from '../../knowledge/api-handlers.js';
import {
  handleListBenchmarks,
  handleCreateBenchmark,
  handleGetBenchmark,
  handleUpdateBenchmark,
  handleDeleteBenchmark,
  handleRunBenchmark,
} from '../../knowledge/benchmarks/api-handlers.js';
import {
  deleteCustomSkill,
  listCustomSkillFiles,
  listCustomSkills,
  readCustomSkillFile,
  writeCustomSkillFile,
} from './custom-skills.js';
import { getLibraryCacheStat, listLibrary, listSkillFiles, readSkillFile } from './library.js';
import { handlePersonaLayers } from './api/persona-layers.js';
import { handleExport, handleLibraryEntryExport } from './api/export.js';
import {
  handleDeleteEntry,
  handleFromTemplate,
  handleListAgentLibrary,
  handleLoadEntry,
  handleRenameEntry,
  handleSaveExisting,
  handleSaveNew,
} from './api/agent-library-handlers.js';
import { listDefaultAgents } from './api/agent-library.js';
import {
  handleAutoFillCatalog,
  handleGetModels,
  handlePutActiveModel,
  handlePutLocalCatalogEntry,
  handlePutModels,
  handleToggleDefaultModel,
} from './api/models.js';
import { handleGetClassControls, handlePutClassControls, DEFAULT_CLASS_ID } from './api/class-controls.js';
import { handleGetModelsTabState } from './api/models-tab-state.js';
import {
  handleGetDefaultParticipant,
  handleSaveDefaultParticipant,
  handleApplyDefaultToAll,
} from './api/default-participant.js';
import { handleGetWebSearchConfig, handlePostWebSearchConfig } from './api/web-search-config.js';
import { handleGetStatus, handlePostStatusRestart } from './api/status.js';
import { handleGetBudgets, handlePostBudgets } from './api/cost-budgets.js';
import { handleDirectChat } from './api/direct-chat.js';
import { assertWithinBudget } from '../../modules/budgets/enforce.js';
import { handleGetStudentDetail, handleGetStudentsUsage, handleGetUsage } from './api/usage.js';
import { isOwner } from '../../modules/permissions/db/user-roles.js';
import { canAccessAgentGroup } from '../../modules/permissions/access.js';
import { handleGetSessionPayloads } from './api/payloads.js';
import { handleGetRecent } from './api/recent.js';
import { handleGetEntry, handleListLibrary, handleSaveMyEntry } from './api/library.js';
import {
  handleGetMyAgent,
  handleGetGoogleStatus,
  handleGoogleDisconnect,
  handleLogout,
  handleLogoutAll,
} from './api/me.js';
import {
  handleGetSimpleConfig,
  handlePutAgentName,
  handleSimpleRestart,
  handleSimpleReset,
} from './api/simple-config.js';
import { pushToAll, registerSseClient } from './sse.js';

export async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  method: string,
  session: PlaygroundSession,
): Promise<void> {
  // GET /api/groups — list non-draft agent groups the caller may access.
  if (method === 'GET' && url.pathname === '/api/groups') {
    const groups = listAgentGroups().filter(
      (ag) => !!session.userId && canAccessAgentGroup(session.userId, ag.id).allowed,
    );
    return send(res, 200, groups);
  }

  // GET /api/drafts — list drafts with target reference
  if (method === 'GET' && url.pathname === '/api/drafts') {
    return send(res, 200, listDrafts());
  }

  // POST /api/drafts — { targetFolder } → create draft + ensure mg+wiring
  if (method === 'POST' && url.pathname === '/api/drafts') {
    const body = await readJsonBody(req);
    const targetFolder = body.targetFolder as string | undefined;
    if (!targetFolder) return send(res, 400, { error: 'targetFolder required' });
    const denied = requireGroupAccess(targetFolder, session.userId);
    if (denied) return send(res, 403, { error: 'Forbidden' });
    try {
      const draft = createDraft(targetFolder);
      ensureDraftWiring(draft.folder);
      return send(res, 200, draft);
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
  }

  // DELETE /api/drafts/:folder
  const draftMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)$/);
  if (method === 'DELETE' && draftMatch) {
    const draftFolder = draftMatch[1]!;
    {
      const target = draftFolder.startsWith('draft_') ? draftFolder.slice('draft_'.length) : draftFolder;
      const denied = requireGroupAccess(target, session.userId);
      if (denied) return send(res, 403, { error: 'Forbidden' });
    }
    try {
      discardDraft(draftFolder);
      return send(res, 200, { ok: true });
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
  }

  // POST /api/drafts/:folder/apply — apply to target
  const applyMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/apply$/);
  if (method === 'POST' && applyMatch) {
    const draftFolder = applyMatch[1]!;
    {
      const target = draftFolder.startsWith('draft_') ? draftFolder.slice('draft_'.length) : draftFolder;
      const denied = requireGroupAccess(target, session.userId);
      if (denied) return send(res, 403, { error: 'Forbidden' });
    }
    const body = await readJsonBody(req);
    const keepDraft = !!body.keepDraft;
    try {
      applyDraft(draftFolder, { keepDraft });
      return send(res, 200, { ok: true });
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
  }

  // POST /api/drafts/:folder/messages — body: { text, files? } → forward to router.
  // Accepts draft_* (instructor drafts), student_* / ta_* / instructor_*
  // (classroom roles) — anything that's a valid agent_group folder. Gated
  // by requireGroupAccess below: the caller must be a member of the
  // target agent_group.
  //
  // Optional `files: [{ name, mimeType, base64 }]` lets the playground UI
  // send image and PDF attachments. Images run through processImage()
  // (resize to 1024px / JPEG quality 80) and land in content.images[]
  // alongside the text. PDFs save to groups/<folder>/attachments/ and
  // are referenced as `[PDF: attachments/<name>.pdf]` text markers, same
  // convention as Telegram. Total decoded size capped at 25 MB.
  const messagesMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/messages$/);
  if (method === 'POST' && messagesMatch) {
    const draftFolder = messagesMatch[1]!;
    const denied = requireGroupAccess(draftFolder, session.userId);
    if (denied) return send(res, 403, { error: 'Forbidden' });
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req, { maxBytes: 35_000_000 });
    } catch (err) {
      return send(res, 413, { error: (err as Error).message });
    }
    const text = (body.text as string | undefined) ?? '';
    const files = (body.files as Array<{ name?: string; mimeType?: string; base64?: string }> | undefined) ?? [];
    if (!text && files.length === 0) return send(res, 400, { error: 'text or files required' });
    const setupConfig = getSetupConfig();
    if (!setupConfig) return send(res, 503, { error: 'adapter not ready' });

    try {
      ensureDraftMessagingGroup(draftFolder);
      ensureDraftWiring(draftFolder);
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }

    // Process attachments. Errors per-file are reported but don't kill the
    // whole submit — the message still goes through with whatever survived.
    const messageId = `pg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const attachDir = path.join(GROUPS_DIR, draftFolder, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });

    let totalBytes = 0;
    const images: Array<{ base64: string; mimeType: string; containerPath: string }> = [];
    const pdfMarkers: string[] = [];
    const fileErrors: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f || typeof f.base64 !== 'string' || typeof f.mimeType !== 'string') {
        fileErrors.push(`file[${i}]: malformed (need base64 + mimeType)`);
        continue;
      }
      const buffer = Buffer.from(f.base64, 'base64');
      totalBytes += buffer.length;
      if (totalBytes > 25 * 1024 * 1024) {
        fileErrors.push(`file[${i}]: aborted — total attachments exceed 25 MB`);
        break;
      }
      if (f.mimeType.startsWith('image/')) {
        try {
          const savePath = path.join(attachDir, `playground_${messageId}_${i}.jpg`);
          const processed = await processImage(buffer, savePath);
          images.push({
            base64: processed.base64,
            mimeType: processed.mimeType,
            containerPath: `/workspace/agent/attachments/playground_${messageId}_${i}.jpg`,
          });
        } catch (err) {
          fileErrors.push(`file[${i}]: image processing failed — ${(err as Error).message}`);
        }
      } else if (f.mimeType === 'application/pdf') {
        const fallbackName = `playground_${messageId}_${i}.pdf`;
        let safeName = (f.name || fallbackName).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
        // Reject anything that still isn't a safe single-segment name (e.g.
        // empty after stripping, or dotfile-shaped) — fall back to a known-safe
        // generated name rather than writing an attacker-influenced path.
        if (!isSafeAttachmentName(safeName)) safeName = fallbackName;
        const savePath = path.join(attachDir, safeName);
        try {
          fs.writeFileSync(savePath, buffer);
          pdfMarkers.push(`[PDF: attachments/${safeName}]`);
        } catch (err) {
          fileErrors.push(`file[${i}]: PDF save failed — ${(err as Error).message}`);
        }
      } else {
        fileErrors.push(`file[${i}]: unsupported mimeType ${f.mimeType} (only image/* and application/pdf accepted)`);
      }
    }

    if (fileErrors.length > 0) log.warn('Playground attachment(s) had errors', { draftFolder, fileErrors });

    // Compose the chat-sdk-style content. Order: PDF markers prepended to
    // text so the agent sees them in context; images carried separately as
    // content.images[] which the formatter extracts into imagePaths.
    const composedText = [...pdfMarkers, text].filter(Boolean).join('\n');
    const contentObj: Record<string, unknown> = {
      text: composedText,
      sender: 'You',
      senderId: 'playground-user',
    };
    if (images.length > 0) contentObj.images = images;

    const platformId = `${getPlatformPrefix()}${draftFolder}`;
    const event: InboundEvent = {
      channelType: 'playground',
      platformId,
      threadId: null,
      message: {
        id: messageId,
        kind: 'chat',
        content: JSON.stringify(contentObj),
        timestamp: new Date().toISOString(),
        isMention: true, // every playground message engages
        isGroup: false,
      },
    };
    void Promise.resolve(setupConfig.onInboundEvent(event)).catch((err) =>
      log.error('Playground onInboundEvent failed', { draftFolder, err }),
    );
    return send(res, 200, { ok: true, messageId, attachmentErrors: fileErrors.length > 0 ? fileErrors : undefined });
  }

  // GET /api/drafts/:folder/persona — read CLAUDE.local.md
  const personaGet = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/persona$/);
  if (method === 'GET' && personaGet) {
    const draftFolder = personaGet[1]!;
    if (!canReadDraft(draftFolder, session.userId)) return send(res, 403, { error: 'Forbidden' });
    try {
      const personaPath = path.join(GROUPS_DIR, draftFolder, 'CLAUDE.local.md');
      const text = fs.existsSync(personaPath) ? fs.readFileSync(personaPath, 'utf8') : '';
      return send(res, 200, { text });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // PUT /api/drafts/:folder/persona — write CLAUDE.local.md, then recycle
  // any running container for the agent group so the change actually
  // reaches the agent. The persona is composed into the system prompt
  // (codex `baseInstructions`) at container spawn and bound to the codex
  // thread, so a file write alone never reaches a live session — the
  // container must respawn. Mirrors the provider-switch recycle above;
  // the codex thread continuation lives in the container-owned
  // outbound.db, so a host-side respawn is the only clean lever.
  if (method === 'PUT' && personaGet) {
    const draftFolder = personaGet[1]!;
    const denied = requireGroupAccess(draftFolder, session.userId);
    if (denied) return send(res, 403, { error: 'Forbidden' });
    const body = await readJsonBody(req);
    const text = body.text;
    if (typeof text !== 'string') return send(res, 400, { error: 'text (string) required' });
    try {
      const personaPath = path.join(GROUPS_DIR, draftFolder, 'CLAUDE.local.md');
      fs.mkdirSync(path.dirname(personaPath), { recursive: true });
      fs.writeFileSync(personaPath, text);
      let containersRecycled = 0;
      const group = getAgentGroupByFolder(draftFolder);
      if (group) {
        for (const s of getActiveSessions()) {
          if (s.agent_group_id !== group.id) continue;
          if (!isContainerRunning(s.id)) continue;
          try {
            killContainer(s.id, 'persona updated');
            containersRecycled += 1;
          } catch {
            /* best-effort — a stale container is reaped by the next sweep */
          }
        }
      }
      return send(res, 200, { ok: true, bytes: Buffer.byteLength(text), containersRecycled });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // GET /api/drafts/:folder/persona-layers — provider-uniform layered view
  const personaLayersMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/persona-layers$/);
  if (method === 'GET' && personaLayersMatch) {
    if (!canReadDraft(personaLayersMatch[1]!, session.userId)) return send(res, 403, { error: 'Forbidden' });
    const result = handlePersonaLayers(personaLayersMatch[1]!);
    return send(res, result.status, result.body);
  }

  // GET /api/me/agent — agent group assigned to this user (with fallback)
  if (method === 'GET' && url.pathname === '/api/me/agent') {
    const r = handleGetMyAgent(session, url.searchParams.get('seat'));
    return send(res, r.status, r.body);
  }

  // GET /api/me/models-tab-state — per-student greying state for every
  // registered provider (class policy + personal creds + reachability).
  if (method === 'GET' && url.pathname === '/api/me/models-tab-state') {
    const agentGroupId = url.searchParams.get('agentGroupId') ?? '';
    const refreshSpec = url.searchParams.get('refresh') || undefined;
    const r = await handleGetModelsTabState({
      userId: session.userId ?? '',
      agentGroupId,
      classId: DEFAULT_CLASS_ID,
      refreshSpec,
    });
    return send(res, r.status, r.body);
  }

  // POST /api/me/logout — revoke current session
  if (method === 'POST' && url.pathname === '/api/me/logout') {
    const r = handleLogout(session);
    return send(res, r.status, r.body);
  }

  // POST /api/me/logout-all — revoke all sessions for this user
  if (method === 'POST' && url.pathname === '/api/me/logout-all') {
    const r = handleLogoutAll(session);
    return send(res, r.status, r.body);
  }

  // GET /api/me/google — per-student Google connection status.
  if (method === 'GET' && url.pathname === '/api/me/google') {
    const r = handleGetGoogleStatus(session);
    return send(res, r.status, r.body);
  }

  // POST /api/me/google/disconnect — clear per-student Google credentials.
  if (method === 'POST' && url.pathname === '/api/me/google/disconnect') {
    const r = handleGoogleDisconnect(session);
    return send(res, r.status, r.body);
  }

  // GET /api/me/telegram — pairing status + bot handle for the Settings UI.
  if (method === 'GET' && url.pathname === '/api/me/telegram') {
    const { handleGetTelegramStatus } = await import('./api/telegram-pair.js');
    const r = await handleGetTelegramStatus(session);
    return send(res, r.status, r.body);
  }
  // POST /api/me/telegram/pair-code — issue a fresh code for this session's user.
  if (method === 'POST' && url.pathname === '/api/me/telegram/pair-code') {
    const { handleIssuePairCode } = await import('./api/telegram-pair.js');
    const r = handleIssuePairCode(session);
    return send(res, r.status, r.body);
  }

  // GET /api/sessions/:sessionId/payloads?agentGroupId=...&limit=N&after=seq
  if (method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/payloads')) {
    const sessionId = url.pathname.slice('/api/sessions/'.length, -'/payloads'.length);
    const agentGroupId = url.searchParams.get('agentGroupId') ?? '';
    const rawLimit = Number(url.searchParams.get('limit') ?? '20');
    const rawAfter = Number(url.searchParams.get('after') ?? '0');
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 20;
    const afterSeq = Number.isFinite(rawAfter) && rawAfter >= 0 ? rawAfter : 0;
    const userId = session.userId ?? '';
    const r = await handleGetSessionPayloads({
      baseDir: path.join(process.cwd(), 'data', 'proxy-payloads'),
      agentGroupId,
      sessionId,
      limit,
      afterSeq,
      canAccess: (ag) => canAccessAgentGroup(userId, ag).allowed,
    });
    return send(res, r.status, r.body);
  }

  // GET /api/library/defaults — session required (playground auth gate in server.ts)
  if (method === 'GET' && url.pathname === '/api/library/defaults') {
    return send(res, 200, { templates: listDefaultAgents() });
  }

  // GET /api/library — returns all three tiers
  if (method === 'GET' && url.pathname === '/api/library') {
    const r = handleListLibrary(session.userId ?? '');
    return send(res, r.status, r.body);
  }

  // GET /api/library/:tier/:name — single entry
  // POST /api/library/my/:name — save current draft as my-library entry
  const entryMatch = url.pathname.match(/^\/api\/library\/(default|class|my)\/([A-Za-z0-9][A-Za-z0-9_-]*)$/);
  if (entryMatch) {
    if (method === 'GET') {
      const r = handleGetEntry(entryMatch[1]!, entryMatch[2]!, session.userId ?? '');
      return send(res, r.status, r.body);
    }
    if (method === 'POST' && entryMatch[1] === 'my') {
      const body = await readJsonBody(req);
      const r = handleSaveMyEntry(session.userId ?? '', entryMatch[2]!, body as never);
      return send(res, r.status, r.body);
    }
  }

  // GET /api/skills/library — list anthropic/skills cache contents
  if (method === 'GET' && url.pathname === '/api/skills/library') {
    try {
      const refresh = url.searchParams.get('refresh') === '1';
      return send(res, 200, { entries: listLibrary(refresh), cache: getLibraryCacheStat() });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // POST /api/skills/library/refresh — explicit git pull
  if (method === 'POST' && url.pathname === '/api/skills/library/refresh') {
    try {
      return send(res, 200, { entries: listLibrary(true), cache: getLibraryCacheStat() });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // GET /api/skills/library/:category/:name/files
  const skillFilesMatch = url.pathname.match(
    /^\/api\/skills\/library\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/files$/,
  );
  if (method === 'GET' && skillFilesMatch) {
    return send(res, 200, { files: listSkillFiles(skillFilesMatch[1]!, skillFilesMatch[2]!) });
  }

  // GET /api/skills/library/:category/:name/file?path=<relPath>
  const skillFileMatch = url.pathname.match(
    /^\/api\/skills\/library\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/file$/,
  );
  if (method === 'GET' && skillFileMatch) {
    const relPath = url.searchParams.get('path') || 'SKILL.md';
    const text = readSkillFile(skillFileMatch[1]!, skillFileMatch[2]!, relPath);
    if (text === undefined) return send(res, 404, { error: 'not found' });
    return send(res, 200, { text });
  }

  // GET /api/drafts/:folder/skills — current draft's enabled skills
  // PUT /api/drafts/:folder/skills — set enabled skills (array | 'all')
  const skillsMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/skills$/);
  if (method === 'GET' && skillsMatch) {
    const draftFolder = skillsMatch[1]!;
    if (!canReadDraft(draftFolder, session.userId)) return send(res, 403, { error: 'Forbidden' });
    try {
      const group = getAgentGroupByFolder(draftFolder);
      if (!group) return send(res, 404, { error: `Agent group not found: ${draftFolder}` });
      const cfg = materializeContainerJson(group.id);
      return send(res, 200, { skills: cfg.skills });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }
  if (method === 'PUT' && skillsMatch) {
    const draftFolder = skillsMatch[1]!;
    {
      const denied = requireGroupAccess(draftFolder, session.userId);
      if (denied) return send(res, 403, { error: 'Forbidden' });
      const decision = checkDraftMutation(draftFolder, 'skills_put', session.userId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    }
    const body = await readJsonBody(req);
    const skills = body.skills as string[] | 'all' | undefined;
    if (skills === undefined || (skills !== 'all' && !Array.isArray(skills))) {
      return send(res, 400, { error: 'skills must be string[] or "all"' });
    }
    try {
      const group = getAgentGroupByFolder(draftFolder);
      if (!group) return send(res, 404, { error: `Agent group not found: ${draftFolder}` });
      updateContainerConfigJson(group.id, 'skills', skills);
      materializeContainerJson(group.id);
      return send(res, 200, { ok: true, skills });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // GET /api/drafts/:folder/custom-skills — this agent's custom skills
  const customSkillsListMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/custom-skills$/);
  if (method === 'GET' && customSkillsListMatch) {
    if (!canReadDraft(customSkillsListMatch[1]!, session.userId)) return send(res, 403, { error: 'Forbidden' });
    return send(res, 200, { entries: listCustomSkills(customSkillsListMatch[1]!) });
  }

  // GET /api/drafts/:folder/custom-skills/:name/files — file list of one custom skill
  const customSkillFilesMatch = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/custom-skills\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/files$/,
  );
  if (method === 'GET' && customSkillFilesMatch) {
    if (!canReadDraft(customSkillFilesMatch[1]!, session.userId)) return send(res, 403, { error: 'Forbidden' });
    return send(res, 200, { files: listCustomSkillFiles(customSkillFilesMatch[1]!, customSkillFilesMatch[2]!) });
  }

  // GET/PUT /api/drafts/:folder/custom-skills/:name/file?path=<relPath> — one file
  const customSkillFileMatch = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/custom-skills\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/file$/,
  );
  if (customSkillFileMatch) {
    const draftFolder = customSkillFileMatch[1]!;
    const name = customSkillFileMatch[2]!;
    const relPath = url.searchParams.get('path') || 'SKILL.md';
    if (method === 'GET') {
      if (!canReadDraft(draftFolder, session.userId)) return send(res, 403, { error: 'Forbidden' });
      const text = readCustomSkillFile(draftFolder, name, relPath);
      if (text === undefined) return send(res, 404, { error: 'not found' });
      return send(res, 200, { text });
    }
    if (method === 'PUT') {
      const denied = requireGroupAccess(draftFolder, session.userId);
      if (denied) return send(res, 403, { error: 'Forbidden' });
      const decision = checkDraftMutation(draftFolder, 'skills_put', session.userId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req, { maxBytes: 512 * 1024 });
      } catch (err) {
        return send(res, 413, { error: (err as Error).message });
      }
      if (typeof body.content !== 'string') {
        return send(res, 400, { error: 'content (string) required' });
      }
      try {
        writeCustomSkillFile(draftFolder, name, relPath, body.content);
        return send(res, 200, { ok: true });
      } catch (err) {
        return send(res, 400, { error: (err as Error).message });
      }
    }
  }

  // DELETE /api/drafts/:folder/custom-skills/:name — delete a whole custom skill
  const customSkillMatch = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/custom-skills\/([A-Za-z0-9][A-Za-z0-9_.-]*)$/,
  );
  if (method === 'DELETE' && customSkillMatch) {
    const deniedCustomSkill = requireGroupAccess(customSkillMatch[1]!, session.userId);
    if (deniedCustomSkill) return send(res, 403, { error: 'Forbidden' });
    const decision = checkDraftMutation(customSkillMatch[1]!, 'skills_put', session.userId);
    if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    return send(res, 200, { ok: deleteCustomSkill(customSkillMatch[1]!, customSkillMatch[2]!) });
  }

  // GET /api/drafts/:folder/models — catalog + current whitelist
  // PUT /api/drafts/:folder/models — set allowedModels
  const modelsMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/models$/);
  if (method === 'GET' && modelsMatch) {
    if (!canReadDraft(modelsMatch[1]!, session.userId)) return send(res, 403, { error: 'Forbidden' });
    const r = await handleGetModels(modelsMatch[1]!, session.userId ?? '');
    return send(res, r.status, r.body);
  }
  if (method === 'PUT' && modelsMatch) {
    const draftFolder = modelsMatch[1]!;
    {
      const denied = requireGroupAccess(draftFolder, session.userId);
      if (denied) return send(res, 403, { error: 'Forbidden' });
      const decision = checkDraftMutation(draftFolder, 'models_put', session.userId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    }
    const body = await readJsonBody(req);
    const r = handlePutModels(draftFolder, body);
    return send(res, r.status, r.body);
  }

  // PUT /api/drafts/:folder/active-model — set provider + model atomically
  const activeModelMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/active-model$/);
  if (method === 'PUT' && activeModelMatch) {
    const draftFolder = activeModelMatch[1]!;
    {
      const denied = requireGroupAccess(draftFolder, session.userId);
      if (denied) return send(res, 403, { error: 'Forbidden' });
      const decision = checkDraftMutation(draftFolder, 'models_put', session.userId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    }
    const body = await readJsonBody(req);
    const r = await handlePutActiveModel(draftFolder, session.userId ?? '', body);
    return send(res, r.status, r.body);
  }

  // GET /api/simple-config?folder=… — beginner-tab config: template skill
  // shortlist + model choices + the agent's current name/model. Member-
  // readable behind the same draft-read gate as the other drafts GETs.
  if (method === 'GET' && url.pathname === '/api/simple-config') {
    const folder = url.searchParams.get('folder') || '';
    if (!canReadDraft(folder, session.userId)) return send(res, 403, { error: 'Forbidden' });
    const r = handleGetSimpleConfig(folder);
    return send(res, r.status, r.body);
  }

  // PUT /api/drafts/:folder/name — student-editable assistant name.
  // Reuses the skills_put gate action: name edits belong to the same
  // "save my agent" surface as the skills checklist.
  const nameMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/name$/);
  if (method === 'PUT' && nameMatch) {
    const draftFolder = nameMatch[1]!;
    {
      const denied = requireGroupAccess(draftFolder, session.userId);
      if (denied) return send(res, 403, { error: 'Forbidden' });
      const decision = checkDraftMutation(draftFolder, 'skills_put', session.userId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    }
    const body = await readJsonBody(req);
    const r = handlePutAgentName(draftFolder, body as { name?: unknown });
    return send(res, r.status, r.body);
  }

  // POST /api/simple-restart — recycle the group's container so a simple-tab
  // save takes effect on the next message.
  if (method === 'POST' && url.pathname === '/api/simple-restart') {
    const body = await readJsonBody(req);
    const folder = typeof body.folder === 'string' ? body.folder : '';
    if (!folder) return send(res, 400, { error: 'folder (string) required' });
    {
      const denied = requireGroupAccess(folder, session.userId);
      if (denied) return send(res, 403, { error: 'Forbidden' });
      const decision = checkDraftMutation(folder, 'skills_put', session.userId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    }
    const r = handleSimpleRestart(folder);
    return send(res, r.status, r.body);
  }

  // POST /api/simple-reset — "Start over": wipe the agent's conversation
  // memory so the next message begins fresh (simple tab only).
  if (method === 'POST' && url.pathname === '/api/simple-reset') {
    const body = await readJsonBody(req);
    const folder = typeof body.folder === 'string' ? body.folder : '';
    if (!folder) return send(res, 400, { error: 'folder (string) required' });
    {
      const denied = requireGroupAccess(folder, session.userId);
      if (denied) return send(res, 403, { error: 'Forbidden' });
      const decision = checkDraftMutation(folder, 'skills_put', session.userId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    }
    const r = handleSimpleReset(folder);
    return send(res, r.status, r.body);
  }

  // PUT /api/catalog/local-entries — append/replace a curated entry in
  // config/model-catalog-local.json. Owner-only because the file is global
  // (not draft-scoped) and getModelCatalog() reads it on every API call.
  if (method === 'PUT' && url.pathname === '/api/catalog/local-entries') {
    if (!session.userId || !isOwner(session.userId)) {
      return send(res, 403, { error: 'owner role required to edit the model catalog' });
    }
    const body = await readJsonBody(req);
    const r = handlePutLocalCatalogEntry(body);
    return send(res, r.status, r.body);
  }

  // POST /api/catalog/auto-fill — best-effort metadata lookup. HF API for
  // local, hardcoded table for claude/codex. Owner-only because it can hit
  // external services (HuggingFace) on the host's behalf.
  if (method === 'POST' && url.pathname === '/api/catalog/auto-fill') {
    if (!session.userId || !isOwner(session.userId)) {
      return send(res, 403, { error: 'owner role required' });
    }
    const body = await readJsonBody(req);
    const r = await handleAutoFillCatalog(body);
    return send(res, r.status, r.body);
  }

  // PUT /api/catalog/toggle-default — toggle the default flag on a catalog
  // entry. Owner-only (writes to the global catalog file).
  if (method === 'PUT' && url.pathname === '/api/catalog/toggle-default') {
    if (!session.userId || !isOwner(session.userId)) {
      return send(res, 403, { error: 'owner role required' });
    }
    const body = await readJsonBody(req);
    const r = handleToggleDefaultModel(body);
    return send(res, r.status, r.body);
  }

  // GET /api/class-controls — read instructor's tab/provider/auth gates.
  // Open to anyone signed in — students need it to know what UI to render.
  if (method === 'GET' && url.pathname === '/api/class-controls') {
    const r = handleGetClassControls();
    return send(res, r.status, r.body);
  }
  // PUT /api/class-controls — owner-only, mutates config/class-controls.json.
  if (method === 'PUT' && url.pathname === '/api/class-controls') {
    if (!session.userId || !isOwner(session.userId)) {
      return send(res, 403, { error: 'owner role required' });
    }
    const body = await readJsonBody(req);
    const r = handlePutClassControls(body);
    if (r.status === 200) pushToAll('class-controls-changed', r.body);
    return send(res, r.status, r.body);
  }

  // POST /api/direct-chat — bypass agent, call upstream directly via the
  // credential proxy. Used by the Chat tab's "Chat (no agent)" mode.
  // agentFolder is REQUIRED (not just used for usage-recording as before):
  // every turn belongs to some group, and that group is what authorizes the
  // caller (requireGroupAccess — fails closed, unlike canReadDraft) and
  // gates spend (assertWithinBudget). Without this, any signed-in user
  // could omit agentFolder to skip authorization entirely, or address
  // another user's folder to run up someone else's cost budget.
  if (method === 'POST' && url.pathname === '/api/direct-chat') {
    const body = await readJsonBody(req, { maxBytes: 1_000_000 });
    const folder =
      typeof (body as { agentFolder?: unknown }).agentFolder === 'string'
        ? (body as { agentFolder: string }).agentFolder
        : '';
    if (!folder) return send(res, 400, { error: 'agentFolder required' });
    const denied = requireGroupAccess(folder, session.userId);
    if (denied) return send(res, 403, { error: 'Forbidden' });

    const group = getAgentGroupByFolder(folder)!; // requireGroupAccess proved it exists
    const budget = assertWithinBudget(folder, group.id);
    if (!budget.ok) return send(res, 429, { error: budget.reason });

    const r = await handleDirectChat(body);
    return send(res, r.status, r.body);
  }

  // GET /api/usage/:folder — per-agent token + cost aggregation. Available
  // to anyone authenticated (the agent's own home wants this too).
  const usageMatch = url.pathname.match(/^\/api\/usage\/([A-Za-z0-9_-]+)$/);
  if (method === 'GET' && usageMatch) {
    if (!canReadDraft(usageMatch[1]!, session.userId)) return send(res, 403, { error: 'Forbidden' });
    const providersParam = url.searchParams.get('providers');
    const providers = providersParam ? providersParam.split(',').filter(Boolean) : undefined;
    const r = handleGetUsage(usageMatch[1]!, providers);
    return send(res, r.status, r.body);
  }
  // GET /api/usage/_/students — instructor roster. Owner-only since it
  // walks every student_* agent.
  if (method === 'GET' && url.pathname === '/api/usage/_/students') {
    if (!session.userId || !isOwner(session.userId)) {
      return send(res, 403, { error: 'owner role required' });
    }
    const providersParam = url.searchParams.get('providers');
    const providers = providersParam ? providersParam.split(',').filter(Boolean) : undefined;
    const r = handleGetStudentsUsage(providers);
    return send(res, r.status, r.body);
  }
  // GET /api/admin/students/:folder — per-student detail. Owner-only.
  if (method === 'GET' && url.pathname.startsWith('/api/admin/students/')) {
    if (!session.userId || !isOwner(session.userId)) {
      return send(res, 403, { error: 'owner role required' });
    }
    const folder = url.pathname.slice('/api/admin/students/'.length);
    if (!folder) return send(res, 400, { error: 'folder required' });
    const result = await handleGetStudentDetail(folder);
    return send(res, result.status, result.body);
  }

  // GET /api/default-participant — owner/admin: template status
  if (method === 'GET' && url.pathname === '/api/default-participant') {
    const r = handleGetDefaultParticipant(session);
    return send(res, r.status, r.body);
  }
  // POST /api/default-participant/save — owner/admin: snapshot template into slot
  if (method === 'POST' && url.pathname === '/api/default-participant/save') {
    const r = handleSaveDefaultParticipant(session);
    return send(res, r.status, r.body);
  }
  // POST /api/default-participant/apply-all — owner/admin: apply slot to all user-role groups
  if (method === 'POST' && url.pathname === '/api/default-participant/apply-all') {
    const body = await readJsonBody(req);
    const r = handleApplyDefaultToAll(session, body);
    return send(res, r.status, r.body);
  }

  // GET /api/status — owner/admin: host summary + per-agent health roll-up
  if (method === 'GET' && url.pathname === '/api/status') {
    const r = handleGetStatus(session);
    return send(res, r.status, r.body);
  }

  // POST /api/status/restart — owner/admin: restart all containers for an agent group
  if (method === 'POST' && url.pathname === '/api/status/restart') {
    const body = await readJsonBody(req);
    const r = handlePostStatusRestart(session, body);
    return send(res, r.status, r.body);
  }

  // GET /api/web-search-config — owner/admin: active provider + per-backend availability
  if (method === 'GET' && url.pathname === '/api/web-search-config') {
    const r = await handleGetWebSearchConfig(session);
    return send(res, r.status, r.body);
  }
  // POST /api/web-search-config — owner/admin: set the active provider
  if (method === 'POST' && url.pathname === '/api/web-search-config') {
    const body = await readJsonBody(req);
    const r = handlePostWebSearchConfig(session, body);
    return send(res, r.status, r.body);
  }

  // GET /api/budgets — owner/admin: per-member cost + budget summary
  if (method === 'GET' && url.pathname === '/api/budgets') {
    const r = handleGetBudgets(session);
    return send(res, r.status, r.body);
  }
  // POST /api/budgets — owner/admin: write budget config
  if (method === 'POST' && url.pathname === '/api/budgets') {
    const body = await readJsonBody(req);
    const r = handlePostBudgets(session, body);
    return send(res, r.status, r.body);
  }

  // Agent library routes — /api/drafts/:folder/library[/:slug[/save|load]]
  // These must be checked before the generic export route to avoid slug
  // collisions with path suffixes.

  // POST /api/drafts/:folder/library/from-template — create a new library
  // entry from a default template. Checked before slug routes so "from-template"
  // is not mistaken for a user slug.
  const fromTemplateMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/library\/from-template$/);
  if (method === 'POST' && fromTemplateMatch) {
    const draftFolder = fromTemplateMatch[1]!;
    const denied = requireGroupAccess(draftFolder, session.userId);
    if (denied) return send(res, 403, { error: 'Forbidden' });
    const body = await readJsonBody(req);
    const r = handleFromTemplate(draftFolder, session.userId, body as never);
    return send(res, r.status, r.body);
  }

  const libBase = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/library$/);
  if (libBase) {
    const draftFolder = libBase[1]!;
    if (method === 'GET') {
      const r = handleListAgentLibrary(draftFolder, session.userId);
      return send(res, r.status, r.body);
    }
    if (method === 'POST') {
      const denied = requireGroupAccess(draftFolder, session.userId);
      if (denied) return send(res, 403, { error: 'Forbidden' });
      const body = await readJsonBody(req);
      const r = handleSaveNew(draftFolder, session.userId, body as never);
      return send(res, r.status, r.body);
    }
  }

  const libSlugSave = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/library\/([A-Za-z0-9][A-Za-z0-9_-]*)\/save$/,
  );
  if (method === 'POST' && libSlugSave) {
    const draftFolder = libSlugSave[1]!;
    const denied = requireGroupAccess(draftFolder, session.userId);
    if (denied) return send(res, 403, { error: 'Forbidden' });
    const body = await readJsonBody(req);
    const r = handleSaveExisting(draftFolder, session.userId, libSlugSave[2]!, body as never);
    return send(res, r.status, r.body);
  }

  const libSlugLoad = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/library\/([A-Za-z0-9][A-Za-z0-9_-]*)\/load$/,
  );
  if (method === 'POST' && libSlugLoad) {
    const draftFolder = libSlugLoad[1]!;
    const denied = requireGroupAccess(draftFolder, session.userId);
    if (denied) return send(res, 403, { error: 'Forbidden' });
    const r = handleLoadEntry(draftFolder, session.userId, libSlugLoad[2]!);
    return send(res, r.status, r.body);
  }

  const libSlug = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/library\/([A-Za-z0-9][A-Za-z0-9_-]*)$/);
  if (libSlug) {
    const draftFolder = libSlug[1]!;
    if (method === 'PUT') {
      const denied = requireGroupAccess(draftFolder, session.userId);
      if (denied) return send(res, 403, { error: 'Forbidden' });
      const body = await readJsonBody(req);
      const r = handleRenameEntry(draftFolder, session.userId, libSlug[2]!, body as never);
      return send(res, r.status, r.body);
    }
    if (method === 'DELETE') {
      const denied = requireGroupAccess(draftFolder, session.userId);
      if (denied) return send(res, 403, { error: 'Forbidden' });
      const r = handleDeleteEntry(draftFolder, session.userId, libSlug[2]!);
      return send(res, r.status, r.body);
    }
  }

  // GET /api/drafts/:folder/library/:slug/export — download a specific library entry as zip
  const libExportMatch = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/library\/([A-Za-z0-9][A-Za-z0-9_-]*)\/export$/,
  );
  if (method === 'GET' && libExportMatch) {
    const draftFolder = libExportMatch[1]!;
    const slug = libExportMatch[2]!;
    const format = url.searchParams.get('format') ?? 'all';
    const result = await handleLibraryEntryExport(draftFolder, slug, session.userId, format);
    if ('buffer' in result) {
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${result.filename}"`,
        'content-length': result.buffer.length,
        'cache-control': 'no-store',
      });
      res.end(result.buffer);
      return;
    }
    return send(res, result.status, { error: result.error });
  }

  // GET /api/drafts/:folder/export — download agent as zip bundle
  const exportMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/export$/);
  if (method === 'GET' && exportMatch) {
    const draftFolder = exportMatch[1]!;
    const format = url.searchParams.get('format') ?? 'all';
    const result = await handleExport(draftFolder, session.userId, format);
    if ('buffer' in result) {
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${result.filename}"`,
        'content-length': result.buffer.length,
        'cache-control': 'no-store',
      });
      res.end(result.buffer);
      return;
    }
    return send(res, result.status, { error: result.error });
  }

  // GET /api/drafts/:folder/files/:messageId/:filename — serve an agent-produced
  // file from the playground-outbox staging dir. Files land here via the
  // playground adapter when the container's send_file MCP tool fires; the
  // chat tab renders <a download> links pointing at this route.
  const outboxFileMatch = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/files\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
  );
  if (method === 'GET' && outboxFileMatch) {
    const draftFolder = outboxFileMatch[1]!;
    const messageId = outboxFileMatch[2]!;
    const filename = outboxFileMatch[3]!;
    if (!canReadDraft(draftFolder, session.userId)) return send(res, 403, { error: 'Forbidden' });
    if (!isSafeAttachmentName(messageId) || !isSafeAttachmentName(filename)) {
      return send(res, 400, { error: 'Invalid path' });
    }
    const filePath = path.join(playgroundOutboxDir(draftFolder, messageId), filename);
    if (!fs.existsSync(filePath)) return send(res, 404, { error: 'File not found' });
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return send(res, 400, { error: 'Invalid file' });
    res.writeHead(200, {
      'content-type': contentTypeFor(filename),
      'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      'content-length': stat.size,
      'cache-control': 'private, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // GET /api/drafts/:folder/recent — last N chat-kind messages across this
  // agent group's active sessions. Used by chat.js on mount and after an
  // SSE reconnect so a dropped EventSource window doesn't permanently
  // hide the agent's reply.
  const recentMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/recent$/);
  if (method === 'GET' && recentMatch) {
    const draftFolder = recentMatch[1]!;
    if (!canReadDraft(draftFolder, session.userId)) return send(res, 403, { error: 'Forbidden' });
    const limit = Number(url.searchParams.get('limit') ?? '20');
    const sinceSeq = Number(url.searchParams.get('sinceSeq') ?? '0');
    const r = handleGetRecent(draftFolder, { limit, sinceSeq });
    return send(res, r.status, r.body);
  }

  // GET /api/drafts/:folder/stream — Server-Sent Events for outbound messages.
  // Same folder-name loosening as the messages POST above so classroom
  // students get a live stream from their student_NN agent.
  const streamMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/stream$/);
  if (method === 'GET' && streamMatch) {
    const draftFolder = streamMatch[1]!;
    if (!canReadDraft(draftFolder, session.userId)) return send(res, 403, { error: 'Forbidden' });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`event: hello\ndata: {"draftFolder":"${draftFolder}"}\n\n`);
    const cleanup = registerSseClient({ draftFolder, cookieValue: session.cookieValue, res });
    req.on('close', cleanup);
    return;
  }

  // GET  /api/drafts/:folder/knowledge/corpora
  // POST /api/drafts/:folder/knowledge/corpora
  const knowledgeCorporaMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/knowledge\/corpora$/);
  if (knowledgeCorporaMatch) {
    const folder = knowledgeCorporaMatch[1]!;
    if (method === 'GET') {
      if (!canReadDraft(folder, session.userId)) return send(res, 403, { error: 'Forbidden' });
      const r = await handleListCorpora(folder);
      return send(res, r.status, r.body);
    }
    if (method === 'POST') {
      const denied = requireGroupAccess(folder, session.userId);
      if (denied) return send(res, 403, { error: 'Forbidden' });
      const decision = checkDraftMutation(folder, 'file_put', session.userId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
      const body = await readJsonBody(req);
      const r = await handleCreateCorpus(folder, body);
      return send(res, r.status, r.body);
    }
  }

  // GET    /api/drafts/:folder/knowledge/corpora/:id
  // DELETE /api/drafts/:folder/knowledge/corpora/:id
  const knowledgeCorpusMatch = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/knowledge\/corpora\/([A-Za-z0-9_-]+)$/,
  );
  if (knowledgeCorpusMatch) {
    const folder = knowledgeCorpusMatch[1]!;
    const id = knowledgeCorpusMatch[2]!;
    if (method === 'GET') {
      if (!canReadDraft(folder, session.userId)) return send(res, 403, { error: 'Forbidden' });
      const r = await handleGetCorpus(folder, id);
      return send(res, r.status, r.body);
    }
    if (method === 'DELETE') {
      const denied = requireGroupAccess(folder, session.userId);
      if (denied) return send(res, 403, { error: 'Forbidden' });
      const decision = checkDraftMutation(folder, 'file_put', session.userId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
      const r = await handleDeleteCorpus(folder, id);
      if (r.status === 204) {
        res.writeHead(204);
        res.end();
        return;
      }
      return send(res, r.status, r.body);
    }
  }

  // PUT  /api/drafts/:folder/knowledge/corpora/:id/upload?filename=
  const knowledgeUploadMatch = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/knowledge\/corpora\/([A-Za-z0-9_-]+)\/upload$/,
  );
  if (method === 'PUT' && knowledgeUploadMatch) {
    const folder = knowledgeUploadMatch[1]!;
    const id = knowledgeUploadMatch[2]!;
    const deniedUpload = requireGroupAccess(folder, session.userId);
    if (deniedUpload) return send(res, 403, { error: 'Forbidden' });
    const decision = checkDraftMutation(folder, 'file_put', session.userId);
    if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    const filename = url.searchParams.get('filename') ?? 'upload';
    let data: Buffer;
    try {
      data = await readRawBody(req);
    } catch (err) {
      return send(res, 413, { error: (err as Error).message });
    }
    const r = await handleUploadSource(folder, id, filename, data);
    if (r.status === 204) {
      res.writeHead(204);
      res.end();
      return;
    }
    return send(res, r.status, r.body);
  }

  // POST /api/drafts/:folder/knowledge/corpora/:id/ingest
  const knowledgeIngestMatch = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/knowledge\/corpora\/([A-Za-z0-9_-]+)\/ingest$/,
  );
  if (method === 'POST' && knowledgeIngestMatch) {
    const folder = knowledgeIngestMatch[1]!;
    const id = knowledgeIngestMatch[2]!;
    const deniedIngest = requireGroupAccess(folder, session.userId);
    if (deniedIngest) return send(res, 403, { error: 'Forbidden' });
    const decision = checkDraftMutation(folder, 'file_put', session.userId);
    if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    // Ingest embeds every chunk of the corpus (dense/hybrid strategies) —
    // unbounded spend without this gate. requireGroupAccess above already
    // proved the group exists.
    const ingestGroup = getAgentGroupByFolder(folder)!;
    const ingestBudget = assertWithinBudget(folder, ingestGroup.id);
    if (!ingestBudget.ok) return send(res, 429, { error: ingestBudget.reason });
    const r = await handleIngest(folder, id);
    return send(res, r.status, r.body);
  }

  // GET  /api/drafts/:folder/knowledge/corpora/:id/inspect
  const knowledgeInspectMatch = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/knowledge\/corpora\/([A-Za-z0-9_-]+)\/inspect$/,
  );
  if (method === 'GET' && knowledgeInspectMatch) {
    const folder = knowledgeInspectMatch[1]!;
    const id = knowledgeInspectMatch[2]!;
    if (!canReadDraft(folder, session.userId)) return send(res, 403, { error: 'Forbidden' });
    const r = await handleInspect(folder, id);
    return send(res, r.status, r.body);
  }

  // POST /api/drafts/:folder/knowledge/corpora/:id/query
  const knowledgeQueryMatch = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/knowledge\/corpora\/([A-Za-z0-9_-]+)\/query$/,
  );
  if (method === 'POST' && knowledgeQueryMatch) {
    const folder = knowledgeQueryMatch[1]!;
    const id = knowledgeQueryMatch[2]!;
    if (!canReadDraft(folder, session.userId)) return send(res, 403, { error: 'Forbidden' });
    // Dense/hybrid queries embed the query text — unbounded spend without
    // this gate. canReadDraft (unlike requireGroupAccess) falls through
    // open when the folder has no agent_groups row, so only gate when a
    // group actually exists; a query against a nonexistent group 404s
    // inside handleQuery before it would ever embed anything.
    const queryGroup = getAgentGroupByFolder(folder);
    if (queryGroup) {
      const queryBudget = assertWithinBudget(folder, queryGroup.id);
      if (!queryBudget.ok) return send(res, 429, { error: queryBudget.reason });
    }
    const body = await readJsonBody(req);
    const { query = '', k = 5 } = body as { query?: string; k?: number };
    const r = await handleQuery(folder, id, query, k);
    return send(res, r.status, r.body);
  }

  // GET  /api/drafts/:folder/knowledge/benchmarks
  // POST /api/drafts/:folder/knowledge/benchmarks
  const benchmarksMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/knowledge\/benchmarks$/);
  if (benchmarksMatch) {
    const folder = benchmarksMatch[1]!;
    if (method === 'GET') {
      if (!canReadDraft(folder, session.userId)) return send(res, 403, { error: 'Forbidden' });
      const r = await handleListBenchmarks(folder);
      return send(res, r.status, r.body);
    }
    if (method === 'POST') {
      if (!canReadDraft(folder, session.userId)) return send(res, 403, { error: 'Forbidden' });
      const denied = requireGroupAccess(folder, session.userId);
      if (denied) return send(res, 403, { error: 'Forbidden' });
      const body = await readJsonBody(req);
      const r = await handleCreateBenchmark(folder, body);
      return send(res, r.status, r.body);
    }
  }

  // GET    /api/drafts/:folder/knowledge/benchmarks/:id
  // PUT    /api/drafts/:folder/knowledge/benchmarks/:id
  // DELETE /api/drafts/:folder/knowledge/benchmarks/:id
  const benchmarkMatch = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/knowledge\/benchmarks\/([A-Za-z0-9_-]+)$/,
  );
  if (benchmarkMatch) {
    const folder = benchmarkMatch[1]!;
    const id = benchmarkMatch[2]!;
    if (!canReadDraft(folder, session.userId)) return send(res, 403, { error: 'Forbidden' });
    if (method === 'GET') {
      const r = await handleGetBenchmark(folder, id);
      return send(res, r.status, r.body);
    }
    if (method === 'PUT') {
      const denied = requireGroupAccess(folder, session.userId);
      if (denied) return send(res, 403, { error: 'Forbidden' });
      const body = await readJsonBody(req);
      const r = await handleUpdateBenchmark(folder, id, body);
      return send(res, r.status, r.body);
    }
    if (method === 'DELETE') {
      const denied = requireGroupAccess(folder, session.userId);
      if (denied) return send(res, 403, { error: 'Forbidden' });
      const r = await handleDeleteBenchmark(folder, id);
      if (r.status === 204) {
        res.writeHead(204);
        res.end();
        return;
      }
      return send(res, r.status, r.body);
    }
  }

  // POST /api/drafts/:folder/knowledge/benchmarks/:id/run
  const benchmarkRunMatch = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/knowledge\/benchmarks\/([A-Za-z0-9_-]+)\/run$/,
  );
  if (method === 'POST' && benchmarkRunMatch) {
    const folder = benchmarkRunMatch[1]!;
    const id = benchmarkRunMatch[2]!;
    if (!canReadDraft(folder, session.userId)) return send(res, 403, { error: 'Forbidden' });
    const denied = requireGroupAccess(folder, session.userId);
    if (denied) return send(res, 403, { error: 'Forbidden' });
    // A benchmark run embeds the query for every query in the benchmark
    // (dense/hybrid corpora) — unbounded spend without this gate.
    // requireGroupAccess above already proved the group exists.
    const runGroup = getAgentGroupByFolder(folder)!;
    const runBudget = assertWithinBudget(folder, runGroup.id);
    if (!runBudget.ok) return send(res, 429, { error: runBudget.reason });
    const body = await readJsonBody(req);
    const k = typeof body.k === 'number' ? body.k : 5;
    const r = await handleRunBenchmark(folder, id, k);
    return send(res, r.status, r.body);
  }

  send(res, 404, { error: `No route: ${method} ${url.pathname}` });
}
