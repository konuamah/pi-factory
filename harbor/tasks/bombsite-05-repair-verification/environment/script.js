/*
 * DOCTOR PORTFOLIO PAGE — script.js
 *
 * Behavior only. No styling: this project intentionally has no CSS, so this
 * script performs no styling work of any kind.
 *
 * Behaviors:
 *   1. Section toggling — nav links show their target section and hide the rest.
 *   2. Contact form validation — validates name/email/message on submit and
 *      shows a plain-text result; blocks the mailto navigation on errors.
 *   3. Footer year — sets #year to the current year.
 *
 * Every id referenced here is defined in index.html.
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1. Section toggling
   * ------------------------------------------------------------------ */
  var sections = document.querySelectorAll('main section');
  var navLinks = document.querySelectorAll('nav a[href^="#"]');

  function showSection(id) {
    var i;
    for (i = 0; i < sections.length; i += 1) {
      sections[i].hidden = (sections[i].id !== id);
    }
  }

  for (var l = 0; l < navLinks.length; l += 1) {
    navLinks[l].addEventListener('click', function (event) {
      var targetId = this.getAttribute('href').substring(1);
      showSection(targetId);
    });
  }

  /* ------------------------------------------------------------------ *
   * 2. Contact form validation
   * ------------------------------------------------------------------ */
  var form = document.getElementById('contact-form');
  var nameField = document.getElementById('contact-name');
  var emailField = document.getElementById('contact-email');
  var messageField = document.getElementById('contact-message');
  var result = document.getElementById('form-result');

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  if (form) {
    form.addEventListener('submit', function (event) {
      var name = nameField.value.trim();
      var email = emailField.value.trim();
      var message = messageField.value.trim();
      var errors = [];

      if (name === '') {
        errors.push('Please enter your name.');
      }
      if (email === '') {
        errors.push('Please enter your email address.');
      } else if (!isValidEmail(email)) {
        errors.push('Please enter a valid email address.');
      }
      if (message === '') {
        errors.push('Please enter a message.');
      }

      if (errors.length > 0) {
        // Block the mailto navigation so the page does not jump.
        event.preventDefault();
        result.textContent = errors.join(' ');
      } else {
        // Success message. The form still submits to action="mailto:[Email]",
        // which opens the visitor's mail client with the message pre-filled.
        result.textContent = 'Message ready — your mail client should open to send it.';
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 3. Footer year
   * ------------------------------------------------------------------ */
  var year = document.getElementById('year');
  if (year) {
    year.textContent = String(new Date().getFullYear());
  }
})();
