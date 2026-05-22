const form = document.getElementById('seat-form');
const select = document.getElementById('seat-select');
const pwField = document.getElementById('pw-field');
const pwInput = document.getElementById('pw');
const errorEl = document.getElementById('error');

let passwordRequired = false;

fetch('/api/seats')
  .then((r) => r.json())
  .then(({ seats, passwordRequired: pwReq }) => {
    passwordRequired = pwReq;
    for (const s of seats) {
      const opt = document.createElement('option');
      opt.value = s.slug;
      opt.textContent = s.label;
      select.appendChild(opt);
    }
    if (pwReq) pwField.style.display = '';
    select.focus();
  })
  .catch(() => {
    errorEl.textContent = 'Could not load seat list.';
    errorEl.style.display = '';
  });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.style.display = 'none';
  const slug = select.value;

  if (!passwordRequired) {
    // No password needed — go straight to the playground with the seat in the URL.
    window.location.href = `/playground/?seat=${encodeURIComponent(slug)}`;
    return;
  }

  // Validate password server-side before redirecting.
  try {
    const r = await fetch('/pick-seat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, password: pwInput.value }),
    });
    if (r.ok) {
      const { redirectUrl } = await r.json();
      window.location.href = redirectUrl;
    } else {
      const { error } = await r.json();
      errorEl.textContent = error || 'Something went wrong.';
      errorEl.style.display = '';
      if (r.status === 401) pwInput.focus();
    }
  } catch {
    errorEl.textContent = 'Network error — try again.';
    errorEl.style.display = '';
  }
});
