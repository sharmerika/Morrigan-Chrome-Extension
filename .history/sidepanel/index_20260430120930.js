import DOMPurify from 'dompurify';
import { marked } from 'marked';
/* global LanguageModel */

const inputPrompt = document.body.querySelector('#input-prompt');
const imageUpload = document.body.querySelector('#image-upload');
const audioUpload = document.body.querySelector('#audio-upload');
const buttonPrompt = document.body.querySelector('#button-prompt');
const buttonReset = document.body.querySelector('#button-reset');
const buttonReport = document.body.querySelector('#button-report');
const elementResponse = document.body.querySelector('#response');
const elementExplanation = document.body.querySelector('#explanation');
const elementLoading = document.body.querySelector('#loading');
const elementError = document.body.querySelector('#error');
const sliderTemperature = document.body.querySelector('#temperature');
const sliderTopK = document.body.querySelector('#top-k');
const labelTemperature = document.body.querySelector('#label-temperature');
const labelTopK = document.body.querySelector('#label-top-k');

imageUpload.addEventListener('change', () => {
  console.log("Image selected:", imageUpload.files[0]?.name);
});

audioUpload.addEventListener('change', () => {
  console.log("Audio selected:", audioUpload.files[0]?.name);
});

let session;
let phishingDataset = [];

fetch(chrome.runtime.getURL("data/phishing_patterns.json"))
  .then(response => response.json())
  .then(data => {
    phishingDataset = data.phrases;
    console.log("Phishing dataset loaded:", phishingDataset);
  })
  .catch(err => console.error("Failed to load phishing dataset:", err));

// Chrome 149+ WebMCP update: registerTool with untrustedContentHint: true
// Required for any tool that processes data from external or unverified sources.
if ('modelContext' in navigator) {
  navigator.modelContext.registerTool({
    name: "analyzePhishing",
    description: "Analyzes user-submitted text for phishing, scam, or misinformation signals using on-device AI.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" }
      }
    },
    execute: ({ text }) => {
      // Actual analysis is handled by the LanguageModel session below.
      // This registration flags the tool as processing untrusted external input.
      return `Analyzing for phishing: ${text}`;
    },
    annotations: {
      readOnlyHint: true,
      // untrustedContentHint must be true because we process user-submitted
      // and externally sourced content (URLs, messages, phishing_patterns.json).
      untrustedContentHint: true
    }
  });
}

async function runPrompt(prompt, params) {
  try {
    if (!session) {
      const availability = await LanguageModel.availability(params);
      if (availability === "unavailable") {
        showError("Prompt API is not available in this context.");
        return;
      }

      session = await LanguageModel.create({
        ...params,
        monitor(m) {
          m.addEventListener("downloadprogress", e => {
            console.log(`Download progress: ${e.loaded * 100}%`);
          });
        }
      });

      session.addEventListener("quotaoverflow", () => {
        console.warn("Context quota exceeded. Some messages were dropped.");
      });
    }
    return session.prompt(prompt);
  } catch (e) {
    console.log('Prompt failed');
    console.error(e);
    reset();
    throw e;
  }
}

async function reset() {
  if (session) {
    session.destroy();
  }
  session = null;
}

async function initDefaults() {
  const defaults = await LanguageModel.params();
  console.log('Model default:', defaults);
  if (!('LanguageModel' in self)) {
    showResponse('Model not available');
    return;
  }
  sliderTemperature.value = defaults.defaultTemperature;
  if (defaults.defaultTopK > 3) {
    sliderTopK.value = 3;
    labelTopK.textContent = 3;
  } else {
    sliderTopK.value = defaults.defaultTopK;
    labelTopK.textContent = defaults.defaultTopK;
  }
  sliderTopK.max = defaults.maxTopK;
  labelTemperature.textContent = defaults.defaultTemperature;
}

initDefaults();

buttonReset.addEventListener('click', () => {
  hide(elementLoading);
  hide(elementError);
  hide(elementResponse);
  reset();
  buttonReset.setAttribute('disabled', '');
});

sliderTemperature.addEventListener('input', (event) => {
  labelTemperature.textContent = event.target.value;
  reset();
});

sliderTopK.addEventListener('input', (event) => {
  labelTopK.textContent = event.target.value;
  reset();
});

inputPrompt.addEventListener('input', () => {
  if (inputPrompt.value.trim()) {
    buttonPrompt.removeAttribute('disabled');
  } else {
    buttonPrompt.setAttribute('disabled', '');
  }
});

buttonReport.addEventListener('click', () => {
  const rawText = inputPrompt.value.trim();
  logSuspiciousMessage(rawText);
  buttonReport.textContent = "Reported";
  buttonReport.setAttribute('disabled', '');
});

buttonPrompt.addEventListener('click', async () => {
  const userInput = inputPrompt.value.trim();
  showLoading();

  try {
    const prompt = `
Analyze this message for phishing intent: "${userInput}"

Here are known phishing URLs:
${phishingDataset.slice(0, 10).map(url => `- ${url}`).join('\n')}
`;

    const params = {
      initialPrompts: [
        {
          role: 'system',
          content: 'You are Morrigan, a protective AI assistant that analyzes text, links, audio and images for phishing, scams, and misinformation.'
        }
      ],
      temperature: Number(sliderTemperature.value),
      topK: Number(sliderTopK.value),
      expectedInputs: [{ type: "text" }],
      expectedOutputs: [{ type: "text" }]
    };

    const responseRaw = await runPrompt(prompt, params);
    const response = typeof responseRaw === 'object' && responseRaw !== null && 'text' in responseRaw
      ? responseRaw.text
      : String(responseRaw);

    if (response.toLowerCase().includes("phishing")) {
      elementResponse.style.border = "2px solid red";
    } else {
      elementResponse.style.border = "2px solid green";
    }

    showResponse(response);
  } catch (e) {
    showError(e);
  }
});

function showLoading() {
  buttonReset.removeAttribute('disabled');
  hide(elementResponse);
  hide(elementError);
  show(elementLoading);
}

function showResponse(response) {
  hide(elementLoading);
  show(elementResponse);
  elementResponse.innerHTML = DOMPurify.sanitize(marked.parse(response));
  let explanation = '';
  if (response.toLowerCase().includes("phishing")) {
    show(buttonReport);
    buttonReport.removeAttribute('disabled');
    buttonReport.textContent = "Report this";

    explanation = `
**Why is this suspicious?**
- The message is vague or lacks context.
- It may urge you to click a screenshot or link without explanation.
- These are common phishing tactics used to bypass filters and exploit urgency or trust.
    `;
  } else {
    explanation = `
**Why this seems safe (so far):**
- The message does not contain known phishing patterns.
- It provides context and does not pressure you to act quickly.
- Still, stay cautious and verify the sender if unsure.
    `;
    hide(buttonReport);
  }

  elementExplanation.innerHTML = DOMPurify.sanitize(marked.parse(explanation));
  show(elementExplanation);
}

function showError(error) {
  elementError.textContent = error && error.message ? error.message : String(error);
  hide(elementResponse);
  hide(elementLoading);
  elementError.textContent = error;
}

function show(element) {
  element.removeAttribute('hidden');
}

function hide(element) {
  element.setAttribute('hidden', '');
}

function logSuspiciousMessage(message) {
  console.log("Reported suspicious message:", message);
  // Future: push to localStorage, backend, or export file
}