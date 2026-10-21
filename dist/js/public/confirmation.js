// Confirmation page: shows the reference returned by the submission and applies branding.

import { $ } from '../utils/dom.js';
import { loadPublicSettings } from './api.js';
import { applyBranding, pageTitle } from './branding.js';
import { applyShopLinks } from './shop.js';

const params = new URLSearchParams(window.location.search);

function fill() {
  const reference = params.get('ref') || sessionStorage.getItem('partnershipy.last_reference') || '';
  const products = params.get('products');
  const terms = params.get('terms');
  const duplicate = params.get('duplicate') === '1';

  const refNode = $('[data-reference]');
  if (refNode) refNode.textContent = reference || '—';
  const countNode = $('[data-product-count]');
  if (countNode) countNode.textContent = products || '—';
  const termsNode = $('[data-terms-version]');
  if (termsNode) termsNode.textContent = terms ? `v${terms}` : '—';

  if (duplicate) {
    const note = document.createElement('p');
    note.className = 'alert alert--info';
    note.setAttribute('role', 'status');
    note.textContent = 'This application had already been received — you are seeing the original confirmation.';
    document.querySelector('.confirmation__card')?.prepend(note);
  }

  // If someone lands here without submitting, send them home.
  if (!reference) {
    const lede = document.querySelector('.confirmation__lede');
    if (lede) {
      lede.textContent =
        'We could not find a submission reference. If you just applied, check your email for confirmation. Otherwise, you can start a new application from the home page.';
    }
  }
}

loadPublicSettings()
  .then(({ settings }) => {
    applyBranding(settings);
    applyShopLinks(settings);
    pageTitle('Application received', settings);
  })
  .catch((error) => {
    console.error('confirmation branding failed', error);
  })
  .finally(fill);
