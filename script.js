// Stage 1: static UI shell. Mock data only — no network calls.

const views = {
  form: document.getElementById("view-form"),
  loading: document.getElementById("view-loading"),
  result: document.getElementById("view-result"),
  error: document.getElementById("view-error"),
};

const form = document.getElementById("fight-form");
const inputA = document.getElementById("fighter-a");
const inputB = document.getElementById("fighter-b");

const MOCK_DELAY_MS = 1500;

// Show exactly one view; every other view gets `hidden`.
function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    el.hidden = key !== name;
  }
}

function showError(message) {
  document.getElementById("error-message").textContent = message;
  showView("error");
}

// Placeholder art: a solid-color SVG with the fighter's initial, as a data URI.
function placeholderImage(label, color) {
  const initial = (label.trim()[0] || "?").toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
    <rect width="200" height="200" fill="${color}"/>
    <text x="100" y="125" font-family="sans-serif" font-size="80" font-weight="700"
      fill="#fff" text-anchor="middle">${initial.replace(/[<>&"']/g, "")}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function mockFight(fighterA, fighterB) {
  const winnerSide = Math.random() < 0.5 ? "a" : "b";
  const winner = winnerSide === "a" ? fighterA : fighterB;
  const loser = winnerSide === "a" ? fighterB : fighterA;
  return {
    winner,
    winnerSide,
    reasoning: `Placeholder verdict: ${winner} outmaneuvers ${loser} with sheer determination. This text will come from the judge in Stage 3.`,
    imageA: placeholderImage(fighterA, "#3a6ea5"),
    imageB: placeholderImage(fighterB, "#a53a3a"),
  };
}

function renderResult(fighterA, fighterB, result) {
  document.getElementById("result-winner").textContent = result.winner;
  document.getElementById("result-reasoning").textContent = result.reasoning;

  const sides = [
    { label: fighterA, image: result.imageA, key: "a" },
    { label: fighterB, image: result.imageB, key: "b" },
  ];
  for (const side of sides) {
    const img = document.getElementById(`image-${side.key}`);
    img.src = side.image;
    img.alt = side.label;
    document.getElementById(`label-${side.key}`).textContent = side.label;
    document
      .getElementById(`card-${side.key}`)
      .classList.toggle("is-winner", side.key === result.winnerSide);
  }

  showView("result");
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const fighterA = inputA.value.trim();
  const fighterB = inputB.value.trim();

  if (!fighterA || !fighterB) {
    showError("Both fighters need a name before they can fight.");
    return;
  }

  showView("loading");
  setTimeout(() => {
    renderResult(fighterA, fighterB, mockFight(fighterA, fighterB));
  }, MOCK_DELAY_MS);
});

document.querySelectorAll('[data-action="new-fight"]').forEach((btn) => {
  btn.addEventListener("click", () => {
    showView("form");
    inputA.focus();
  });
});

showView("form");
