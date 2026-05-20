// Enrollment form: POST to /login/enroll, redirect on success, show error on failure.
(function () {
  const enrollForm = document.getElementById('enroll-form');
  const enrollError = document.getElementById('enroll-error');

  if (enrollForm && enrollError) {
    enrollForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      enrollError.style.display = 'none';
      enrollError.textContent = '';

      const emailInput = document.getElementById('enroll-email');
      const passcodeInput = document.getElementById('enroll-passcode');
      const email = emailInput ? emailInput.value.trim() : '';
      const passcode = passcodeInput ? passcodeInput.value.trim() : '';

      const submitBtn = enrollForm.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      try {
        const resp = await fetch('/login/enroll', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, passcode }),
        });

        if (resp.ok) {
          const data = await resp.json().catch(() => ({}));
          window.location.href = data.redirect || '/playground/';
          return;
        }

        const data = await resp.json().catch(() => ({}));
        if (resp.status === 409) {
          enrollError.textContent = data.error || 'This email has already been enrolled. Contact your instructor to re-enroll.';
        } else {
          enrollError.textContent = data.error || 'Invalid email or passcode. Please try again.';
        }
        enrollError.style.display = '';
      } catch (err) {
        enrollError.textContent = "Couldn't reach the server. Please try again in a moment.";
        enrollError.style.display = '';
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }
})();

// Lost-link recovery: submits email to /login/recover and displays
// the server's generic response (success regardless of whether the
// email matched a roster row — anti-enumeration).
(function () {
  const form = document.getElementById('recover-form');
  const status = document.getElementById('recover-status');
  if (!form || !status) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById('recover-email');
    const email = emailInput ? emailInput.value.trim() : '';
    if (!email) return;
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    status.textContent = 'Sending…';
    try {
      const resp = await fetch('/login/recover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await resp.json().catch(() => ({}));
      status.textContent = data.message || 'Request submitted.';
    } catch (err) {
      status.textContent = "Couldn't reach the server. Please try again in a moment.";
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
})();
