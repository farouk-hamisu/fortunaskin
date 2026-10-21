// Applicant wizard: step machine, draft persistence, staged uploads, terms consent
// and submission. No applicant account is created — drafts live on this device only.

import { $, el, clearNode, scrollToAndFocus, debounce } from '../utils/dom.js';
import { toast, clearToasts } from '../utils/toast.js';
import { loadDraft, saveDraft, clearDraft } from '../utils/draft.js';
import {
  loadPublicSettings,
  getTermsMetadata,
  getTermsDocumentUrl,
  prepareUpload,
  uploadToSignedUrl,
  submitApplication,
} from './api.js';
import { applyBranding, pageTitle } from './branding.js';
import { applyShopLinks, resolveShopUrl, resolveShopLabel } from './shop.js';
import { renderFieldStep, validateField, validateHandlesList } from './step-fields.js';
import {
  createProductGrid,
  createEmptyProduct,
  validateProductList,
  ACCEPTED_IMAGE_TYPES,
  hasReadyScreenshot,
} from './product-grid.js';
import { openTermsViewer } from './terms-viewer.js';
import { renderReview } from './review.js';
import { showLoader, hideLoader } from './page-loader.js';

const STEP_COUNT = 5;
const STEP_TITLES = [
  'Your details',
  'Your channels',
  'Select products',
  'Terms & consent',
  'Review & submit',
];

const state = {
  step: 1,
  settings: {},
  fieldConfigs: [], // administrator-configured field rows (array)
  fields: {},       // applicant-entered values keyed by field_key
  otherHandles: [],
  products: [],
  fieldsById: {},
  consent: { checked: false, reviewedVersion: null, openedAt: null, documentId: null },
  terms: null, // { id, version, sha256, available, title }
  uploadToken: null,
  idempotencyKey: null,
  submitting: false,
  maxProducts: 30,
};

let stepFieldController = null;
let productGrid = null;
let reviewController = null;

/* ------------------------------------------------------------------ helpers */

function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function newToken() {
  // lowercase uuid without dashes — matches ^[a-f0-9-]{16,64}$
  return uuid();
}

const scheduleSave = debounce(() => {
  try {
    saveDraft(state);
  } catch (error) {
    console.warn('draft save failed', error);
  }
}, 400);

function persistNow() {
  try {
    saveDraft(state);
  } catch (error) {
    console.warn('draft save failed', error);
  }
}

/* --------------------------------------------------------------- step chrome */

// True when every required input of a step is filled in and valid. Drives the
// stepper's completion markers so they always reflect real progress — including
// after a direct jump that skipped a step.
function stepIsComplete(step) {
  if (step === 1 || step === 2) return validateStepFields(step).length === 0;
  if (step === 3) return validateProductList(state.products, state.settings || {}).length === 0;
  if (step === 4) return consentGateMet();
  return false; // the review step is only finished once submitted
}

// Handles every stepper click: backward jumps are always allowed (answers live
// in wizard state + the draft, so nothing is lost), forward jumps require the
// current step to be valid first so required information can never be skipped.
function navigateToStep(target) {
  if (target === state.step) return;
  if (target < state.step) {
    goToStep(target);
    return;
  }
  if (!canLeaveStep(state.step)) return;
  goToStep(target);
}

function renderStepper(activeStep) {
  const list = $('[data-stepper]');
  clearNode(list);
  for (let i = 1; i <= STEP_COUNT; i += 1) {
    const done = i < activeStep && stepIsComplete(i);
    const incomplete = i < activeStep && !done;
    const stateName = i === activeStep ? 'current' : done ? 'done' : incomplete ? 'incomplete' : 'todo';
    const item = el('li', { class: 'wizard-step', 'data-state': stateName });
    const index = el('span', { class: 'wizard-step__index', 'aria-hidden': 'true' }, [
      done ? document.createTextNode('✓') : document.createTextNode(String(i)),
    ]);
    const label = el('span', { class: 'wizard-step__label', text: STEP_TITLES[i - 1] });

    if (i === activeStep) {
      item.append(el('div', { class: 'wizard-step__body' }, [index, label]));
    } else {
      // Completed and upcoming steps are both clickable: go back to review or
      // correct answers, or jump forward once the current step is complete.
      const forward = i > activeStep;
      item.append(
        el(
          'button',
          {
            type: 'button',
            class: 'wizard-step__body',
            'aria-label': forward
              ? `Go to step ${i}: ${STEP_TITLES[i - 1]}`
              : `Go back to step ${i}: ${STEP_TITLES[i - 1]}${incomplete ? ' (not completed yet)' : ''}`,
            onClick: () => navigateToStep(i),
          },
          [index, label],
        ),
      );
    }

    if (i === activeStep) item.setAttribute('aria-current', 'step');
    list.append(item);
  }
  const progress = $('[data-progress-bar]');
  if (progress) {
    const pct = Math.round((activeStep / STEP_COUNT) * 100);
    progress.style.width = `${pct}%`;
    progress.parentElement?.setAttribute('aria-valuenow', String(activeStep));
    progress.parentElement?.setAttribute('aria-valuemax', String(STEP_COUNT));
    const label = $('[data-progress-label]');
    if (label) label.textContent = `Step ${activeStep} of ${STEP_COUNT}: ${STEP_TITLES[activeStep - 1]}`;
  }
}

function showPanel(name) {
  document.querySelectorAll('[data-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
}

function setNavState({ nextDisabled = false, nextLabel = 'Continue', submit = false, backHidden = false } = {}) {
  const next = $('[data-action="next"]');
  const back = $('[data-action="back"]');
  const submitBtn = $('[data-action="submit"]');
  if (next) {
    next.hidden = submit;
    next.disabled = nextDisabled;
    next.textContent = nextLabel;
  }
  if (back) back.hidden = backHidden;
  if (submitBtn) submitBtn.hidden = !submit;
}

function clearAlert() {
  const alert = $('[data-form-alert]');
  if (alert) {
    alert.hidden = true;
    alert.textContent = '';
  }
}

function showAlert(message, type = 'danger') {
  const alert = $('[data-form-alert]');
  if (!alert) return;
  alert.hidden = false;
  alert.textContent = message;
  alert.dataset.type = type;
  alert.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ---------------------------------------------------------------- step: fields */

function fieldOnChange(key, value) {
  if (key.startsWith('handle:')) {
    const parts = key.split(':');
    if (parts[1] === 'add') {
      state.otherHandles.push({ platform: '', handle: '' });
    } else if (parts[1] === 'remove') {
      state.otherHandles.splice(Number(parts[2]), 1);
    } else {
      const index = Number(parts[1]);
      const prop = parts[2];
      if (state.otherHandles[index]) state.otherHandles[index][prop] = value;
    }
  } else {
    state.fields[key] = value;
  }
  scheduleSave();
}

function stepFieldsFor(stepNumber) {
  return state.fieldConfigs
    .filter((field) => Number(field.step) === stepNumber && field.enabled !== false)
    .sort((a, b) => a.position - b.position);
}

/* ---------------------------------------------------------------- step: terms */

function consentGateMet() {
  if (!state.consent.checked) return false;
  if (!state.terms?.version) return false;
  return state.consent.reviewedVersion === state.terms.version;
}

function renderTermsStep() {
  const panel = $('[data-panel="terms"]');
  clearNode(panel);

  panel.append(
    el('div', { class: 'step-intro' }, [
      el('h2', { class: 'step-intro__title', text: 'Terms & Conditions' }),
      el('p', {
        class: 'step-intro__description',
        text: 'Please read the Terms & Conditions carefully. Opening the document is required before you can continue — viewing does not accept the terms on your behalf.',
      }),
    ]),
  );

  const card = el('div', { class: 'card terms-card' });
  const metaLine = el('p', { class: 'terms-card__meta' });
  if (state.terms?.version) {
    metaLine.textContent = `Version ${state.terms.version}${state.terms.available ? '' : ' — document not published yet'}`;
  } else {
    metaLine.textContent = 'Loading terms…';
  }
  card.append(metaLine);

  const actions = el('div', { class: 'terms-card__actions' });
  const viewBtn = el('button', {
    type: 'button',
    class: 'btn btn--secondary',
    text: 'Read Terms & Conditions',
    onClick: async () => {
      viewBtn.disabled = true;
      try {
        const result = await openTermsViewer({
          title: state.terms?.title || 'Terms & Conditions',
          fetchDocument: () => getTermsDocumentUrl(),
        });
        if (result.opened && result.document) {
          state.consent.reviewedVersion = result.document.version;
          state.consent.documentId = result.document.id;
          state.consent.openedAt = result.openedAt;
          // If the version changed while the user was reading, they must re-read.
          if (state.terms && result.document.version !== state.terms.version) {
            state.consent.checked = false;
            toast('A newer version of the Terms is available. Please review it before continuing.', { type: 'warning' });
            renderTermsStep();
            setNavState({ nextDisabled: true, backHidden: state.step === 1 });
            return;
          }
          toast('Terms viewed. Please confirm below to continue.', { type: 'default' });
          renderTermsStep();
          setNavState({ nextDisabled: !consentGateMet(), backHidden: state.step === 1 });
          scheduleSave();
        } else if (!result.document) {
          toast('The Terms document could not be loaded. Please try again.', { type: 'error' });
        }
      } finally {
        viewBtn.disabled = false;
      }
    },
  });
  actions.append(viewBtn);
  card.append(actions);

  const reviewedBadge = el('p', { class: 'terms-card__reviewed' });
  if (consentGateMet()) {
    reviewedBadge.textContent = `✓ You have reviewed version ${state.consent.reviewedVersion}.`;
  } else if (state.consent.reviewedVersion) {
    reviewedBadge.textContent = `You last viewed version ${state.consent.reviewedVersion}. Please review the current version.`;
  } else {
    reviewedBadge.textContent = 'You have not opened the document yet.';
  }
  card.append(reviewedBadge);

  // Consent checkbox — only enabled after the document has been opened.
  const consentId = 'consent-checkbox';
  const checkbox = el('input', {
    type: 'checkbox',
    id: consentId,
    class: 'checkbox-input',
  });
  checkbox.checked = Boolean(state.consent.checked);
  checkbox.disabled = !state.consent.reviewedVersion || state.consent.reviewedVersion !== state.terms?.version;
  checkbox.addEventListener('change', () => {
    state.consent.checked = checkbox.checked;
    if (!checkbox.checked) {
      // keep reviewedVersion so they don't have to reopen unless version changes
    }
    scheduleSave();
    setNavState({ nextDisabled: !consentGateMet(), backHidden: state.step === 1 });
  });

  const label = el('label', { class: 'checkbox', for: consentId }, [
    checkbox,
    el('span', {
      class: 'checkbox__label',
      text: 'I have read and agree to the Terms & Conditions and consent to my information being processed for this application.',
    }),
  ]);
  card.append(label);

  if (!state.terms?.available) {
    card.append(
      el('p', {
        class: 'terms-card__unavailable',
        text: 'The Terms & Conditions have not been published yet. Please try again later or contact us.',
      }),
    );
  }

  panel.append(card);
}

/* --------------------------------------------------------------- step: review */

function renderReviewStep() {
  const panel = $('[data-panel="review"]');
  clearNode(panel);
  panel.append(
    el('div', { class: 'step-intro' }, [
      el('h2', { class: 'step-intro__title', text: 'Review & submit' }),
    ]),
  );
  const container = el('div', { 'data-review-body': true });
  panel.append(container);
  reviewController = renderReview({ state, container, settings: state.settings });

  const printRow = el('div', { class: 'review-print-row' }, [
    el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--sm',
      text: 'Print / Save as PDF',
      onClick: () => reviewController?.print(),
    }),
  ]);
  panel.append(printRow);
}

/* -------------------------------------------------------------- step routing */

function validateStepFields(stepNumber) {
  const errors = [];
  for (const field of stepFieldsFor(stepNumber)) {
    if (field.field_type === 'handles') continue;
    const message = validateField(field, state.fields[field.field_key] || '');
    if (message) errors.push({ key: field.field_key, message });
  }
  const handlesField = stepFieldsFor(stepNumber).find((f) => f.field_type === 'handles');
  if (handlesField) {
    for (const issue of validateHandlesList(state.otherHandles)) {
      errors.push({ key: handlesField.field_key, message: issue.message });
    }
  }
  return errors;
}

function canLeaveStep(step) {
  if (step === 1 || step === 2) {
    const errors = validateStepFields(step);
    if (errors.length) {
      if (Number(state.step) === step) stepFieldController?.showErrors(errors);
      showAlert(`Please fix ${errors.length} issue${errors.length === 1 ? '' : 's'} before continuing.`);
      return false;
    }
    return true;
  }
  if (step === 3) {
    if (!productGrid) return true;
    const errors = productGrid.validate();
    if (errors.length) {
      productGrid.showErrors(errors);
      showAlert(errors[0]);
      return false;
    }
    return true;
  }
  if (step === 4) {
    if (!consentGateMet()) {
      showAlert('Please read the Terms & Conditions and confirm your consent to continue.');
      return false;
    }
    return true;
  }
  return true;
}

function renderCurrentStep() {
  clearAlert();
  clearToasts();
  renderStepper(state.step);
  document.querySelectorAll('[data-step-title]').forEach((node) => {
    node.textContent = STEP_TITLES[state.step - 1];
  });

  if (state.step === 1 || state.step === 2) {
    showPanel('fields');
    const panel = $('[data-panel="fields"]');
    const stepFields = stepFieldsFor(state.step);
    stepFieldController = renderFieldStep({
      container: panel,
      fields: stepFields,
      state,
      onFieldChange: fieldOnChange,
      legend: STEP_TITLES[state.step - 1],
      description:
        state.step === 1
          ? 'Tell us who you are and where we can ship products.'
          : 'Share the channels you create on so we can see your work.',
    });
    setNavState({ backHidden: state.step === 1, nextLabel: 'Continue' });
  } else if (state.step === 3) {
    showPanel('products');
    const panel = $('[data-panel="products"]');
    clearNode(panel);
    const shopLabel =
      String(state.settings.shop_name || state.settings.brand_name || 'Furtuna Skin').trim() || 'Furtuna Skin';
    const instructions = String(state.settings.product_instructions || '').trim();
    const shopUrl = resolveShopUrl(state.settings);
    const shopButtonLabel = resolveShopLabel(state.settings);
    panel.append(
      el('div', { class: 'step-intro' }, [
        el('h2', { class: 'step-intro__title', text: 'Select your products' }),
        el('p', {
          class: 'step-intro__description',
          text:
            instructions ||
            `Pick the products you want to collaborate on from the official ${shopLabel} shop, then come back here and upload one clear screenshot of each selected product — up to ${state.maxProducts} screenshots. Take each screenshot directly from the shop product page so we can see the exact item you chose, one screenshot per field. No product names, descriptions, or links are needed — the screenshots are your selection.`,
        }),
      ]),
    );
    panel.append(
      el('div', { class: 'shop-banner' }, [
        el('div', { class: 'shop-banner__body' }, [
          el('p', { class: 'shop-banner__title', text: `Select your products from the official ${shopLabel} shop` }),
          el('ol', { class: 'shop-banner__steps' }, [
            el('li', { text: 'Open the official shop and browse all available products.' }),
            el('li', { text: 'Choose the products you want to feature and screenshot each one on its product page.' }),
            el('li', { text: 'Return to this tab and upload one screenshot per product in the fields below.' }),
          ]),
        ]),
        el('a', {
          class: 'btn btn--primary btn--sm',
          href: shopUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: shopButtonLabel,
        }),
      ]),
    );
    productGrid = createProductGrid({
      state,
      onChange: () => {
        scheduleSave();
      },
      uploadFile: async ({ file, contentType, onStateChange }) => {
        const type = contentType || file.type;
        const prepared = await prepareUpload({
          contentType: type,
          uploadToken: state.uploadToken,
        });
        state.uploadToken = prepared.uploadToken;
        if (prepared.maxBytes && file.size > prepared.maxBytes) {
          const limitMb = Math.max(1, Math.round(prepared.maxBytes / (1024 * 1024)));
          throw new Error(`"${file.name}" is larger than the ${limitMb} MB limit. Please choose a smaller image.`);
        }
        await uploadToSignedUrl({
          path: prepared.path,
          token: prepared.token,
          signedUrl: prepared.signedUrl,
          file,
          contentType: type,
          onStateChange,
        });
        return {
          path: prepared.path,
          token: prepared.token,
          mime: type,
          size: file.size,
          uploadToken: prepared.uploadToken,
        };
      },
      maxProducts: state.maxProducts,
      acceptedTypes: state.settings?.accepted_image_types?.length
        ? state.settings.accepted_image_types
        : ACCEPTED_IMAGE_TYPES,
    });
    panel.append(productGrid.element);
    productGrid.render();
    productGrid.restoreBlobs();
    setNavState({ backHidden: false, nextLabel: 'Continue' });
  } else if (state.step === 4) {
    showPanel('terms');
    renderTermsStep();
    setNavState({ nextDisabled: !consentGateMet(), backHidden: false });
  } else if (state.step === 5) {
    showPanel('review');
    renderReviewStep();
    setNavState({ submit: true, backHidden: false });
  }

  // move focus to the step heading for screen-reader users
  const heading = document.querySelector('[data-panel]:not([hidden]) .step-intro__title');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    scrollToAndFocus(heading);
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function goToStep(step) {
  state.step = Math.min(STEP_COUNT, Math.max(1, step));
  persistNow();
  renderCurrentStep();
  // update URL hash without scrolling
  history.replaceState(null, '', `#step-${state.step}`);
}

/* ---------------------------------------------------------------- submission */

function buildSubmissionPayload() {
  const payload = {
    idempotency_key: state.idempotencyKey,
    upload_token: state.uploadToken,
    consent: true,
    terms_reviewed: true,
    terms_document_id: state.consent.documentId || state.terms?.id || null,
    terms_version: state.terms?.version || state.consent.reviewedVersion,
    terms_sha256: state.terms?.sha256 || '',
    // Screenshots only: submit fields that actually contain an uploaded image.
    // Each submitted field is named "Screenshot N" — applicants never enter
    // product names, descriptions, or links.
    products: state.products
      .filter(hasReadyScreenshot)
      .map((product, position) => ({
        name: `Screenshot ${position + 1}`,
        files: product.files
          .filter((file) => file.status === 'ready' && file.path)
          .map((file) => ({
            storage_path: file.path,
            mime_type: file.mime,
            file_size: Number(file.size) || 0,
            sha256: file.sha256 || '',
            original_name: file.originalName || '',
          })),
      })),
  };

  for (const field of state.fieldConfigs) {
    if (!field.enabled) continue;
    const key = field.field_key;
    if (key === 'other_handles') {
      payload.other_handles = state.otherHandles
        .filter((item) => (item.platform || '').trim() || (item.handle || '').trim())
        .map((item) => ({ platform: (item.platform || '').trim(), handle: (item.handle || '').trim() }));
      continue;
    }
    payload[key] = state.fields[key] || '';
  }
  if (!payload.other_handles) payload.other_handles = [];
  return payload;
}

async function submit() {
  if (state.submitting) return;

  // Key hygiene: drafts written by older builds may carry malformed keys,
  // which the server rejects outright. Regenerate when clearly invalid — but
  // never change the upload token while staged uploads exist (their storage
  // paths are bound to it).
  if (!state.idempotencyKey || state.idempotencyKey.length < 16 || state.idempotencyKey.length > 80) {
    state.idempotencyKey = uuid();
  }
  const hasStaged = state.products.some(hasReadyScreenshot);
  if (!hasStaged && (!state.uploadToken || !/^[a-f0-9-]{16,64}$/.test(state.uploadToken))) {
    state.uploadToken = newToken();
  }

  // Final validation sweep across every step
  const problems = [];
  for (const step of [1, 2]) {
    for (const issue of validateStepFields(step)) problems.push(issue.message);
  }
  if (productGrid) {
    problems.push(...productGrid.validate());
  } else {
    // Product grid not yet rendered (deep link straight to review) — the same
    // rules run against the raw wizard state.
    problems.push(...validateProductList(state.products, state.settings || {}));
  }
  if (!consentGateMet()) problems.push('Please confirm your consent to the Terms & Conditions.');

  if (problems.length) {
    showAlert(problems[0]);
    return;
  }

  state.submitting = true;
  const submitBtn = $('[data-action="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';
  }
  clearAlert();
  showLoader('Submitting application…');

  try {
    const payload = buildSubmissionPayload();
    const result = await submitApplication(payload);

    // success — clear draft, hand off to confirmation (loader stays visible
    // through the navigation so there is no flash of the form)
    await clearDraft();
    const params = new URLSearchParams({
      ref: result.reference || '',
      products: String(result.product_count ?? payload.products.length),
      terms: result.terms_version || state.terms?.version || '',
    });
    if (result.duplicate) params.set('duplicate', '1');
    sessionStorage.setItem('partnershipy.last_reference', result.reference || '');
    window.location.href = `/confirmation.html?${params.toString()}`;
  } catch (error) {
    console.error('submission failed', error);
    hideLoader();
    state.submitting = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit application';
    }
    if (error?.code === 'upload_missing' || error?.code === 'invalid_upload_path') {
      // The staged screenshots are gone (or were never actually stored —
      // drafts written by older builds). Mark them failed so the Screenshots
      // step shows re-upload controls instead of a phantom "Uploaded" state.
      for (const product of state.products) {
        for (const file of product.files) {
          if (file.status === 'ready') {
            file.status = 'error';
            file.error = 'Please upload this screenshot again.';
            file.path = '';
            file.token = '';
          }
        }
      }
      persistNow();
      const message =
        'Your screenshots could not be verified, so the application was not submitted. Please re-upload them on the Screenshots step, then submit again.';
      showAlert(message);
      toast(message, { type: 'error', timeout: 9000 });
      return;
    }
    const message = error?.message || 'Something went wrong. Your answers are saved on this device — please try again.';
    showAlert(message);
    toast(message, { type: 'error', timeout: 8000 });
    persistNow();
  }
}

/* ---------------------------------------------------------------------- boot */

function restoreDraft(restored) {
  const { mode, draft } = restored;
  if (!draft) return false;

  state.step = Number(draft.step) || 1;
  state.uploadToken = draft.uploadToken || null;
  state.idempotencyKey = draft.idempotencyKey || null;
  state.otherHandles = Array.isArray(draft.otherHandles) ? draft.otherHandles : [];
  state.products = Array.isArray(draft.products)
    ? draft.products.map((product) => ({
        localId: product.localId || createEmptyProduct().localId,
        name: product.name || '',
        url: product.url || '',
        variant: product.variant || '',
        notes: product.notes || '',
        files: Array.isArray(product.files)
          ? product.files.map((file) => ({
              localId: file.localId,
              file: null,
              path: file.path || '',
              token: file.token || '',
              mime: file.mime || '',
              size: Number(file.size) || 0,
              sha256: file.sha256 || '',
              originalName: file.originalName || '',
              status: file.status === 'ready' ? 'ready' : file.status === 'error' ? 'error' : 'idle',
              error: file.error || '',
              previewUrl: '',
            }))
          : [],
      }))
    : [];
  // merge field values — light mode drops sensitive fields, so they start empty
  state.fields = { ...(draft.fields || {}) };
  if (mode === 'light') {
    toast('We restored what we could from your last visit. Some details (name, address, contact) were not kept — please re-enter them.', { type: 'warning', timeout: 9000 });
  } else {
    toast('Welcome back — your draft was restored on this device.', { type: 'default' });
  }
  return true;
}

async function boot() {
  const bootError = $('[data-boot-error]');
  const appRoot = $('[data-wizard-root]');

  // Terms metadata is fetched alongside settings rather than after them, and
  // only the consent step waits for it — the first step renders the moment its
  // own data is ready.
  const termsPromise = getTermsMetadata().catch((error) => {
    console.warn('terms metadata unavailable', error);
    return { available: false };
  });
  termsPromise.then((meta) => {
    if (state.terms) return;
    state.terms = meta;
    // The consent step may already be on screen (deep link / restored draft).
    if (state.step >= 4 && appRoot && !appRoot.hidden) renderCurrentStep();
  });

  try {
    const { settings, fields } = await loadPublicSettings();
    state.settings = settings;
    state.fieldConfigs = fields;
    state.fieldsById = Object.fromEntries(fields.map((f) => [f.field_key, f]));
    state.maxProducts = Math.min(Number(settings.max_products) || 30, 30);

    applyBranding(settings);
    applyShopLinks(settings);
    pageTitle('Apply', settings);

    if (!state.idempotencyKey) state.idempotencyKey = uuid();
    if (!state.uploadToken) state.uploadToken = newToken();

    if (settings.applications_paused) {
      // No closed-card on this page — send visitors home, where the pause
      // notice and disabled start button explain the situation.
      window.location.replace('/');
      return;
    }

    // restore draft
    const restored = restoreDraft(loadDraft());
    if (restored && state.step > STEP_COUNT) state.step = 1;
    if (state.step > STEP_COUNT) state.step = 1;
    // Entering the consent step requires the terms metadata (deep link or a
    // draft saved at step 4+); every other step renders without it.
    if (state.step >= 4) await termsPromise;
    // If draft was restored mid-flow but terms never confirmed, drop to consent step.
    if (restored && state.step >= 4 && !state.terms?.available) {
      state.step = 4;
    }

    appRoot.hidden = false;
    renderCurrentStep();
  } catch (error) {
    console.error('wizard boot failed', error);
    if (bootError) {
      bootError.hidden = false;
      bootError.textContent =
        String(error?.code || '').includes('missing_env')
          ? 'This site is not configured yet. Run "npm run env" to create your environment file.'
          : error?.name === 'EdgeError'
            ? error.message
            : 'We could not load the application form. Please refresh the page or try again later.';
    }
    appRoot.hidden = true;
  } finally {
    // The transition overlay stays up until the form (or its error state) is
    // actually in the DOM — never longer.
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('app:ready'));
    });
  }
}

/* ------------------------------------------------------------------- bindings */

function bindActions() {
  $('[data-action="back"]')?.addEventListener('click', () => {
    goToStep(state.step - 1);
  });
  $('[data-action="next"]')?.addEventListener('click', () => {
    if (!canLeaveStep(state.step)) return;
    goToStep(state.step + 1);
  });
  $('[data-action="submit"]')?.addEventListener('click', (event) => {
    event.preventDefault();
    submit();
  });

  // keep draft fresh on background
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistNow();
  });
  window.addEventListener('beforeunload', persistNow);

  // hash-based deep link to a step
  const match = /^#step-(\d)$/.exec(window.location.hash);
  if (match) {
    const target = Number(match[1]);
    if (target >= 1 && target <= STEP_COUNT) state.step = target;
  }
}

bindActions();
boot();
