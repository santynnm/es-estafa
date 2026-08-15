// Uso: node check-models.mjs TU_GEMINI_API_KEY
const apiKey = process.argv[2];
if (!apiKey) {
  console.error("Uso: node check-models.mjs TU_GEMINI_API_KEY");
  process.exit(1);
}

const candidates = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
];

for (const model of candidates) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Respondé solo con la palabra: ok" }] }],
        generationConfig: { responseMimeType: "text/plain" },
      }),
    });
    const body = await res.json();
    if (res.ok) {
      const text = body?.candidates?.[0]?.content?.parts?.[0]?.text ?? "(sin texto)";
      console.log(`OK   ${model} -> ${res.status} :: ${text.trim().slice(0, 50)}`);
    } else {
      console.log(`FAIL ${model} -> ${res.status} :: ${body?.error?.message?.slice(0, 100)}`);
    }
  } catch (err) {
    console.log(`ERR  ${model} -> ${err.message}`);
  }
}
