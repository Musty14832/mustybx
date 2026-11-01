(function () {
  'use strict';
  const MESSAGES = {
    state_mismatch: 'Login expired or was started in another tab. Please try again.',
    missing_code: 'Deriv did not return a login code. Please try again.',
    missing_verifier: 'Login session expired. Please try again.',
    access_denied: 'You cancelled the Deriv login.',
    token_exchange_failed: 'Deriv rejected the login. Check that the Redirect URL registered on developers.deriv.com matches this site exactly.',
    token_request_failed: 'Could not reach Deriv to finish logging in. Please try again.',
  };

  const q = new URLSearchParams(location.search);
  const err = q.get('error');
  if (err) {
    const el = document.getElementById('error');
    const detail = q.get('detail');
    el.textContent = (MESSAGES[err] || `Login failed (${err}).`) + (detail ? ` Details: ${detail}` : '');
    el.hidden = false;
    history.replaceState(null, '', '/');
  }

  fetch('/api/session', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((s) => {
      if (s.loggedIn) {
        document.getElementById('ctaGuest').hidden = true;
        document.getElementById('ctaUser').hidden = false;
      }
    })
    .catch(() => {});
})();
