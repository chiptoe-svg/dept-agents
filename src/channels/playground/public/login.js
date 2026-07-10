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
