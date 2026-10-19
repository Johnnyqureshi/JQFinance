/* Contact page (Johnny 2026-10-19): the standalone /contact page's
 * form. Posts to POST /api/support (public — no login required, so a
 * locked-out customer can still reach us); on success the form is
 * replaced by the confirmation state on this same page, never a
 * redirect. If the visitor happens to be signed in, their account
 * email is prefilled from /api/auth/me. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  // Prefill the email field for signed-in visitors (fail-quiet when
  // signed out — the endpoint simply won't return a user).
  fetch('/api/auth/me', { credentials: 'include' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (me) {
      var field = $('ctcEmail');
      if (me && me.email && field && !field.value) field.value = me.email;
    })
    .catch(function () { /* prefill is a convenience only */ });

  var form = $('ctcForm');
  if (!form) return;
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var error = $('ctcError');
    var button = $('ctcSubmit');
    var payload = {
      name: $('ctcName').value.trim(),
      email: $('ctcEmail').value.trim(),
      topic: $('ctcTopic').value,
      message: $('ctcMessage').value.trim(),
      website: $('ctcWebsite').value,
    };
    if (!payload.name || !payload.email || !payload.message) {
      error.textContent = 'Please fill in your name, email, and a message.';
      return;
    }
    error.textContent = '';
    button.disabled = true;
    button.textContent = 'Sending…';
    fetch('/api/support', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) throw new Error(data.error || 'Message could not be sent.');
          form.style.display = 'none';
          $('ctcDone').style.display = '';
        });
      })
      .catch(function (err) {
        error.textContent = err.message || 'Message could not be sent. Please email us instead.';
        button.disabled = false;
        button.textContent = 'Send message';
      });
  });
})();
