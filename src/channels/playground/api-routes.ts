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
import { getAgentGroupByFolder, updateAgentGroup } from '../../db/agent-groups.js';
import { getActiveSessions, updateSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../adapter.js';
import { checkDraftMutation } from '../playground-gate-registry.js';
import { canReadDraft } from './draft-read-gate.js';
import { getPlatformPrefix, getSetupConfig } from './adapter.js';
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
import { handleGetClassControls, handlePutClassControls } from './api/class-controls.js';
import { handleGetClassBase, handlePutClassBase } from './api/class-base.js';
import { handleAddStudent, handleGetTunnel, handleStopTunnel } from './api/students-admin.js';
import { handleDirectChat } from './api/direct-chat.js';
import { handleGetStudentDetail, handleGetStudentsUsage, handleGetUsage } from './api/usage.js';
import { isOwner } from '../../modules/permissions/db/user-roles.js';
import { handleGetEntry, handleListLibrary, handleSaveMyEntry } from './api/library.js';
import {
  handleGetMyAgent,
  handleGetGoogleStatus,
  handleGoogleDisconnect,
  handleLogout,
  handleLogoutAll,
} from './api/me.js';
import { pushToAll, registerSseClient } from './sse.js';

export async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  method: string,
  session: PlaygroundSession,
): Promise<void> {
  // GET /api/groups — list non-draft agent groups
  if (method === 'GET' && url.pathname === '/api/groups') {
    return send(res, 200, listAgentGroups());
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
  // (classroom roles) — anything that's a valid agent_group folder. The
  // route is still gated by playground auth (the session check above);
  // for classroom folders the user must be a member of the agent_group,
  // which is enforced in getPlaygroundAgentForUser at sign-in time.
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
        const safeName = (f.name || `playground_${messageId}_${i}.pdf`).replace(/[^A-Za-z0-9._-]/g, '_');
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

  // PUT /api/drafts/:folder/provider — body: { provider: 'claude' | 'codex' }
  // Updates the draft agent_group's provider for permanent change, AND sets
  // the active session's agent_provider so the next container spawn picks
  // it up. Kills any running container so the change applies on the next
  // message immediately.
  const providerMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/provider$/);
  if (method === 'PUT' && providerMatch) {
    const draftFolder = providerMatch[1]!;
    {
      const decision = checkDraftMutation(draftFolder, 'provider_put', session.userId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    }
    const body = await readJsonBody(req);
    const provider = body.provider as string | undefined;
    if (!provider) return send(res, 400, { error: 'provider required' });

    const draft = getAgentGroupByFolder(draftFolder);
    if (!draft) return send(res, 404, { error: 'draft not found' });

    try {
      updateAgentGroup(draft.id, { agent_provider: provider });
      // Apply to any active session for this draft.
      for (const s of getActiveSessions()) {
        if (s.agent_group_id !== draft.id) continue;
        updateSession(s.id, { agent_provider: provider });
        if (isContainerRunning(s.id)) {
          try {
            killContainer(s.id, `provider switched to ${provider}`);
          } catch {
            /* best-effort */
          }
        }
      }
      return send(res, 200, { ok: true, provider });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
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
    const decision = checkDraftMutation(customSkillMatch[1]!, 'skills_put', session.userId);
    if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    return send(res, 200, { ok: deleteCustomSkill(customSkillMatch[1]!, customSkillMatch[2]!) });
  }

  // GET /api/drafts/:folder/models — catalog + current whitelist
  // PUT /api/drafts/:folder/models — set allowedModels
  const modelsMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/models$/);
  if (method === 'GET' && modelsMatch) {
    if (!canReadDraft(modelsMatch[1]!, session.userId)) return send(res, 403, { error: 'Forbidden' });
    const r = await handleGetModels(modelsMatch[1]!);
    return send(res, r.status, r.body);
  }
  if (method === 'PUT' && modelsMatch) {
    const draftFolder = modelsMatch[1]!;
    {
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
      const decision = checkDraftMutation(draftFolder, 'models_put', session.userId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    }
    const body = await readJsonBody(req);
    const r = handlePutActiveModel(draftFolder, body);
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
  // GET /api/class-base — read the shared class base persona (all can read).
  if (method === 'GET' && url.pathname === '/api/class-base') {
    const r = handleGetClassBase();
    return send(res, r.status, r.body);
  }
  // PUT /api/class-base — owner-only, writes data/class-shared-students.md.
  if (method === 'PUT' && url.pathname === '/api/class-base') {
    if (!session.userId || !isOwner(session.userId)) {
      return send(res, 403, { error: 'owner role required' });
    }
    const body = await readJsonBody(req);
    const r = handlePutClassBase(body);
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
  if (method === 'POST' && url.pathname === '/api/direct-chat') {
    const body = await readJsonBody(req, { maxBytes: 1_000_000 });
    const r = await handleDirectChat(body);
    return send(res, r.status, r.body);
  }

  // GET /api/usage/:folder — per-agent token + cost aggregation. Available
  // to anyone authenticated (the agent's own home wants this too).
  const usageMatch = url.pathname.match(/^\/api\/usage\/([A-Za-z0-9_-]+)$/);
  if (method === 'GET' && usageMatch) {
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

  // POST /api/admin/students — provision one new class student. Owner-only;
  // the handler does its own role check.
  if (method === 'POST' && url.pathname === '/api/admin/students') {
    const body = await readJsonBody(req);
    const r = await handleAddStudent(session, body);
    return send(res, r.status, r.body);
  }
  // GET /api/admin/tunnel — current guest-tunnel status. Owner-only.
  if (method === 'GET' && url.pathname === '/api/admin/tunnel') {
    const r = handleGetTunnel(session);
    return send(res, r.status, r.body);
  }
  // POST /api/admin/tunnel/stop — tear down the guest tunnel. Owner-only.
  if (method === 'POST' && url.pathname === '/api/admin/tunnel/stop') {
    const r = handleStopTunnel(session);
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
    const body = await readJsonBody(req);
    const r = handleFromTemplate(fromTemplateMatch[1]!, session.userId, body as never);
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
      const body = await readJsonBody(req);
      const r = handleSaveNew(draftFolder, session.userId, body as never);
      return send(res, r.status, r.body);
    }
  }

  const libSlugSave = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/library\/([A-Za-z0-9][A-Za-z0-9_-]*)\/save$/,
  );
  if (method === 'POST' && libSlugSave) {
    const body = await readJsonBody(req);
    const r = handleSaveExisting(libSlugSave[1]!, session.userId, libSlugSave[2]!, body as never);
    return send(res, r.status, r.body);
  }

  const libSlugLoad = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/library\/([A-Za-z0-9][A-Za-z0-9_-]*)\/load$/,
  );
  if (method === 'POST' && libSlugLoad) {
    const r = handleLoadEntry(libSlugLoad[1]!, session.userId, libSlugLoad[2]!);
    return send(res, r.status, r.body);
  }

  const libSlug = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/library\/([A-Za-z0-9][A-Za-z0-9_-]*)$/);
  if (libSlug) {
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      const r = handleRenameEntry(libSlug[1]!, session.userId, libSlug[2]!, body as never);
      return send(res, r.status, r.body);
    }
    if (method === 'DELETE') {
      const r = handleDeleteEntry(libSlug[1]!, session.userId, libSlug[2]!);
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
    const decision = checkDraftMutation(folder, 'file_put', session.userId);
    if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
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
      const body = await readJsonBody(req);
      const r = await handleUpdateBenchmark(folder, id, body);
      return send(res, r.status, r.body);
    }
    if (method === 'DELETE') {
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
    const body = await readJsonBody(req);
    const k = typeof body.k === 'number' ? body.k : 5;
    const r = await handleRunBenchmark(folder, id, k);
    return send(res, r.status, r.body);
  }

  send(res, 404, { error: `No route: ${method} ${url.pathname}` });
}
