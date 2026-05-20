import { afterEach, describe, expect, it, vi } from 'vitest';

describe('enrollment API', () => {
  afterEach(() => {
    vi.resetModules();
  });

  // ── handleGetClassPasscode ─────────────────────────────────────────────

  describe('handleGetClassPasscode', () => {
    it('returns 403 when session has no userId', async () => {
      vi.doMock('../../../modules/permissions/db/user-roles.js', () => ({
        isOwner: () => false,
        isGlobalAdmin: () => false,
      }));
      vi.doMock('../../../class-enrollment-passcode.js', () => ({
        getCurrentPasscodeCleartext: () => null,
        rotatePasscode: () => '1234',
        verifyPasscode: () => true,
      }));
      vi.doMock('../../../db/classroom-roster.js', () => ({
        lookupRosterByEmail: () => null,
        markEnrolled: () => false,
        isEnrolled: () => false,
      }));
      vi.doMock('../auth-store.js', () => ({
        mintSessionForUser: () => ({ cookieValue: 'c1', userId: null, createdAt: 0, lastActivityAt: 0 }),
        formatSessionCookie: (v: string) => `nc_playground=${v}`,
      }));
      const { handleGetClassPasscode } = await import('./enrollment.js');
      const result = handleGetClassPasscode({ cookieValue: 'x', userId: null, createdAt: 0, lastActivityAt: 0 });
      expect(result.status).toBe(403);
    });

    it('returns 403 for a plain member (non-owner/admin)', async () => {
      vi.doMock('../../../modules/permissions/db/user-roles.js', () => ({
        isOwner: () => false,
        isGlobalAdmin: () => false,
      }));
      vi.doMock('../../../class-enrollment-passcode.js', () => ({
        getCurrentPasscodeCleartext: () => '5678',
        rotatePasscode: () => '5678',
        verifyPasscode: () => true,
      }));
      vi.doMock('../../../db/classroom-roster.js', () => ({
        lookupRosterByEmail: () => null,
        markEnrolled: () => false,
        isEnrolled: () => false,
      }));
      vi.doMock('../auth-store.js', () => ({
        mintSessionForUser: () => ({ cookieValue: 'c1', userId: 'class:s1', createdAt: 0, lastActivityAt: 0 }),
        formatSessionCookie: (v: string) => `nc_playground=${v}`,
      }));
      const { handleGetClassPasscode } = await import('./enrollment.js');
      const result = handleGetClassPasscode({
        cookieValue: 'x',
        userId: 'class:student_01',
        createdAt: 0,
        lastActivityAt: 0,
      });
      expect(result.status).toBe(403);
    });

    it('returns 200 with passcode null for owner when none rotated yet', async () => {
      vi.doMock('../../../modules/permissions/db/user-roles.js', () => ({
        isOwner: (uid: string) => uid === 'owner:1',
        isGlobalAdmin: () => false,
      }));
      vi.doMock('../../../class-enrollment-passcode.js', () => ({
        getCurrentPasscodeCleartext: () => null,
        rotatePasscode: () => '1234',
        verifyPasscode: () => true,
      }));
      vi.doMock('../../../db/classroom-roster.js', () => ({
        lookupRosterByEmail: () => null,
        markEnrolled: () => false,
        isEnrolled: () => false,
      }));
      vi.doMock('../auth-store.js', () => ({
        mintSessionForUser: () => ({ cookieValue: 'c1', userId: 'owner:1', createdAt: 0, lastActivityAt: 0 }),
        formatSessionCookie: (v: string) => `nc_playground=${v}`,
      }));
      const { handleGetClassPasscode } = await import('./enrollment.js');
      const result = handleGetClassPasscode({ cookieValue: 'x', userId: 'owner:1', createdAt: 0, lastActivityAt: 0 });
      expect(result.status).toBe(200);
      expect((result.body as { passcode: string | null }).passcode).toBeNull();
    });

    it('returns 200 with cleartext for owner after rotation', async () => {
      vi.doMock('../../../modules/permissions/db/user-roles.js', () => ({
        isOwner: (uid: string) => uid === 'owner:1',
        isGlobalAdmin: () => false,
      }));
      vi.doMock('../../../class-enrollment-passcode.js', () => ({
        getCurrentPasscodeCleartext: () => '4729',
        rotatePasscode: () => '4729',
        verifyPasscode: () => true,
      }));
      vi.doMock('../../../db/classroom-roster.js', () => ({
        lookupRosterByEmail: () => null,
        markEnrolled: () => false,
        isEnrolled: () => false,
      }));
      vi.doMock('../auth-store.js', () => ({
        mintSessionForUser: () => ({ cookieValue: 'c1', userId: 'owner:1', createdAt: 0, lastActivityAt: 0 }),
        formatSessionCookie: (v: string) => `nc_playground=${v}`,
      }));
      const { handleGetClassPasscode } = await import('./enrollment.js');
      const result = handleGetClassPasscode({ cookieValue: 'x', userId: 'owner:1', createdAt: 0, lastActivityAt: 0 });
      expect(result.status).toBe(200);
      expect((result.body as { passcode: string | null }).passcode).toBe('4729');
    });
  });

  // ── handleRotateClassPasscode ──────────────────────────────────────────

  describe('handleRotateClassPasscode', () => {
    it('returns 403 for non-owner/admin', async () => {
      vi.doMock('../../../modules/permissions/db/user-roles.js', () => ({
        isOwner: () => false,
        isGlobalAdmin: () => false,
      }));
      vi.doMock('../../../class-enrollment-passcode.js', () => ({
        getCurrentPasscodeCleartext: () => null,
        rotatePasscode: () => '1234',
        verifyPasscode: () => true,
      }));
      vi.doMock('../../../db/classroom-roster.js', () => ({
        lookupRosterByEmail: () => null,
        markEnrolled: () => false,
        isEnrolled: () => false,
      }));
      vi.doMock('../auth-store.js', () => ({
        mintSessionForUser: () => ({ cookieValue: 'c1', userId: null, createdAt: 0, lastActivityAt: 0 }),
        formatSessionCookie: (v: string) => `nc_playground=${v}`,
      }));
      const { handleRotateClassPasscode } = await import('./enrollment.js');
      const result = handleRotateClassPasscode({ cookieValue: 'x', userId: null, createdAt: 0, lastActivityAt: 0 });
      expect(result.status).toBe(403);
    });

    it('returns 200 with new passcode for owner', async () => {
      vi.doMock('../../../modules/permissions/db/user-roles.js', () => ({
        isOwner: (uid: string) => uid === 'owner:1',
        isGlobalAdmin: () => false,
      }));
      vi.doMock('../../../class-enrollment-passcode.js', () => ({
        getCurrentPasscodeCleartext: () => '9999',
        rotatePasscode: () => '9999',
        verifyPasscode: () => true,
      }));
      vi.doMock('../../../db/classroom-roster.js', () => ({
        lookupRosterByEmail: () => null,
        markEnrolled: () => false,
        isEnrolled: () => false,
      }));
      vi.doMock('../auth-store.js', () => ({
        mintSessionForUser: () => ({ cookieValue: 'c1', userId: 'owner:1', createdAt: 0, lastActivityAt: 0 }),
        formatSessionCookie: (v: string) => `nc_playground=${v}`,
      }));
      const { handleRotateClassPasscode } = await import('./enrollment.js');
      const result = handleRotateClassPasscode({
        cookieValue: 'x',
        userId: 'owner:1',
        createdAt: 0,
        lastActivityAt: 0,
      });
      expect(result.status).toBe(200);
      expect((result.body as { passcode: string }).passcode).toBe('9999');
    });
  });

  // ── handleEnroll ────────────────────────────────────────────────────────

  describe('handleEnroll', () => {
    it('returns 400 when email or passcode missing', async () => {
      vi.doMock('../../../modules/permissions/db/user-roles.js', () => ({
        isOwner: () => false,
        isGlobalAdmin: () => false,
      }));
      vi.doMock('../../../class-enrollment-passcode.js', () => ({
        getCurrentPasscodeCleartext: () => null,
        rotatePasscode: () => '1234',
        verifyPasscode: () => true,
      }));
      vi.doMock('../../../db/classroom-roster.js', () => ({
        lookupRosterByEmail: () => ({ email: 'a@b.com', user_id: 'class:s1', agent_group_id: null, added_at: 0 }),
        markEnrolled: () => true,
        isEnrolled: () => false,
      }));
      vi.doMock('../auth-store.js', () => ({
        mintSessionForUser: () => ({ cookieValue: 'cook', userId: 'class:s1', createdAt: 0, lastActivityAt: 0 }),
        formatSessionCookie: (v: string) => `nc_playground=${v}`,
      }));
      const { handleEnroll } = await import('./enrollment.js');
      expect((await handleEnroll({})).status).toBe(400);
      expect((await handleEnroll({ email: 'a@b.com' })).status).toBe(400);
      expect((await handleEnroll({ passcode: '1234' })).status).toBe(400);
    });

    it('returns 401 when passcode is wrong', async () => {
      vi.doMock('../../../modules/permissions/db/user-roles.js', () => ({
        isOwner: () => false,
        isGlobalAdmin: () => false,
      }));
      vi.doMock('../../../class-enrollment-passcode.js', () => ({
        getCurrentPasscodeCleartext: () => null,
        rotatePasscode: () => '1234',
        verifyPasscode: () => false, // always wrong
      }));
      vi.doMock('../../../db/classroom-roster.js', () => ({
        lookupRosterByEmail: () => ({ email: 'a@b.com', user_id: 'class:s1', agent_group_id: null, added_at: 0 }),
        markEnrolled: () => true,
        isEnrolled: () => false,
      }));
      vi.doMock('../auth-store.js', () => ({
        mintSessionForUser: () => ({ cookieValue: 'cook', userId: 'class:s1', createdAt: 0, lastActivityAt: 0 }),
        formatSessionCookie: (v: string) => `nc_playground=${v}`,
      }));
      const { handleEnroll } = await import('./enrollment.js');
      const result = await handleEnroll({ email: 'a@b.com', passcode: '0000' });
      expect(result.status).toBe(401);
    });

    it('returns 401 when email not on roster', async () => {
      vi.doMock('../../../modules/permissions/db/user-roles.js', () => ({
        isOwner: () => false,
        isGlobalAdmin: () => false,
      }));
      vi.doMock('../../../class-enrollment-passcode.js', () => ({
        getCurrentPasscodeCleartext: () => null,
        rotatePasscode: () => '1234',
        verifyPasscode: () => true, // passcode correct
      }));
      vi.doMock('../../../db/classroom-roster.js', () => ({
        lookupRosterByEmail: () => null, // not on roster
        markEnrolled: () => false,
        isEnrolled: () => false,
      }));
      vi.doMock('../auth-store.js', () => ({
        mintSessionForUser: () => ({ cookieValue: 'cook', userId: 'class:s1', createdAt: 0, lastActivityAt: 0 }),
        formatSessionCookie: (v: string) => `nc_playground=${v}`,
      }));
      const { handleEnroll } = await import('./enrollment.js');
      const result = await handleEnroll({ email: 'stranger@school.edu', passcode: '1234' });
      expect(result.status).toBe(401);
    });

    it('returns 200 + fresh session when already enrolled (returning device)', async () => {
      vi.doMock('../../../modules/permissions/db/user-roles.js', () => ({
        isOwner: () => false,
        isGlobalAdmin: () => false,
      }));
      vi.doMock('../../../class-enrollment-passcode.js', () => ({
        getCurrentPasscodeCleartext: () => '1234',
        rotatePasscode: () => '1234',
        verifyPasscode: () => true,
      }));
      vi.doMock('../../../db/classroom-roster.js', () => ({
        lookupRosterByEmail: () => ({ email: 'a@b.com', user_id: 'class:s1', agent_group_id: null, added_at: 0 }),
        markEnrolled: () => false, // already claimed by a prior session
        isEnrolled: () => true,
      }));
      vi.doMock('../auth-store.js', () => ({
        mintSessionForUser: () => ({ cookieValue: 'cook2', userId: 'class:s1', createdAt: 0, lastActivityAt: 0 }),
        formatSessionCookie: (v: string) => `nc_playground=${v}`,
      }));
      const { handleEnroll } = await import('./enrollment.js');
      const result = await handleEnroll({ email: 'a@b.com', passcode: '1234' });
      expect(result.status).toBe(200);
      expect(result.setCookie).toContain('nc_playground=cook2');
    });

    it('returns 200 + Set-Cookie on successful enrollment', async () => {
      vi.doMock('../../../modules/permissions/db/user-roles.js', () => ({
        isOwner: () => false,
        isGlobalAdmin: () => false,
      }));
      vi.doMock('../../../class-enrollment-passcode.js', () => ({
        getCurrentPasscodeCleartext: () => '4729',
        rotatePasscode: () => '4729',
        verifyPasscode: () => true,
      }));
      vi.doMock('../../../db/classroom-roster.js', () => ({
        lookupRosterByEmail: () => ({
          email: 'alice@school.edu',
          user_id: 'class:alice',
          agent_group_id: null,
          added_at: 0,
        }),
        markEnrolled: () => true, // won the race
        isEnrolled: () => false,
      }));
      vi.doMock('../auth-store.js', () => ({
        mintSessionForUser: () => ({
          cookieValue: 'cookie-alice',
          userId: 'class:alice',
          createdAt: 0,
          lastActivityAt: 0,
        }),
        formatSessionCookie: (v: string) => `nc_playground=${v}; HttpOnly`,
      }));
      const { handleEnroll } = await import('./enrollment.js');
      const result = await handleEnroll({ email: 'alice@school.edu', passcode: '4729' });
      expect(result.status).toBe(200);
      expect(result.setCookie).toContain('nc_playground=cookie-alice');
      expect((result.body as { ok: boolean; redirect: string }).redirect).toBe('/playground/');
    });
  });
});
