import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import PptxGenJS from "pptxgenjs";

type Finding = {
  title?: string;
  why_it_matters?: string;
  recommended_action?: string;
  evidence_refs?: string[];
};

type SlidePlan = {
  slide_type?: string;
  title?: string;
  key_message?: string;
  bullets?: string[];
  evidence_refs?: string[];
};

export type StoredOutput = {
  title: string;
  output_type?: string | null;
  body_markdown?: string | null;
  data?: {
    summary?: string;
    findings?: Finding[];
    next_actions?: string[];
    deliverable_contract?: {
      type?: string;
      slides?: SlidePlan[];
      sections?: Array<Record<string, unknown>>;
    };
    [key: string]: unknown;
  } | null;
};

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function markdownParagraphs(markdown: string | null | undefined) {
  if (!markdown) return [] as Paragraph[];

  const paragraphs: Paragraph[] = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      paragraphs.push(new Paragraph({ text: "" }));
      continue;
    }

    if (line.startsWith("# ")) {
      paragraphs.push(
        new Paragraph({
          text: line.slice(2),
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 280, after: 140 },
        }),
      );
      continue;
    }

    if (line.startsWith("## ")) {
      paragraphs.push(
        new Paragraph({
          text: line.slice(3),
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 220, after: 100 },
        }),
      );
      continue;
    }

    if (line.startsWith("- ")) {
      paragraphs.push(
        new Paragraph({
          text: line.slice(2),
          bullet: { level: 0 },
          spacing: { after: 70 },
        }),
      );
      continue;
    }

    const recommended = line.match(/^\*\*Recommended action:\*\*\s*(.*)$/i);
    if (recommended) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({ text: "Recommended action: ", bold: true }),
            new TextRun({ text: recommended[1] || "" }),
          ],
          spacing: { after: 100 },
        }),
      );
      continue;
    }

    paragraphs.push(
      new Paragraph({
        text: line.replace(/\*\*/g, ""),
        spacing: { after: 100 },
      }),
    );
  }

  return paragraphs;
}

export async function renderDocx(output: StoredOutput) {
  const data = output.data || {};
  const children: Paragraph[] = [
    new Paragraph({
      children: [
        new TextRun({
          text: output.title || "SignalCore Output",
          bold: true,
          size: 36,
        }),
      ],
      alignment: AlignmentType.LEFT,
      spacing: { after: 260 },
    }),
  ];

  if (clean(data.summary)) {
    children.push(
      new Paragraph({
        text: "Executive Summary",
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 180, after: 120 },
      }),
      new Paragraph({
        text: clean(data.summary),
        spacing: { after: 220 },
      }),
    );
  }

  const findings = Array.isArray(data.findings) ? data.findings : [];
  if (findings.length) {
    children.push(
      new Paragraph({
        text: "Findings",
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 220, after: 120 },
      }),
    );

    findings.forEach((finding, index) => {
      children.push(
        new Paragraph({
          text: String(index + 1) + ". " + (clean(finding.title) || "Finding"),
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 180, after: 90 },
        }),
      );

      if (clean(finding.why_it_matters)) {
        children.push(
          new Paragraph({
            text: clean(finding.why_it_matters),
            spacing: { after: 100 },
          }),
        );
      }

      if (clean(finding.recommended_action)) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: "Recommended action: ", bold: true }),
              new TextRun({ text: clean(finding.recommended_action) }),
            ],
            spacing: { after: 120 },
          }),
        );
      }
    });
  }

  const nextActions = Array.isArray(data.next_actions)
    ? data.next_actions.map(String).filter(Boolean)
    : [];

  if (nextActions.length) {
    children.push(
      new Paragraph({
        text: "Next Actions",
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 220, after: 120 },
      }),
    );
    for (const item of nextActions) {
      children.push(
        new Paragraph({
          text: item,
          bullet: { level: 0 },
          spacing: { after: 80 },
        }),
      );
    }
  }

  if (!clean(data.summary) && findings.length === 0 && nextActions.length === 0) {
    children.push(...markdownParagraphs(output.body_markdown));
  }

  const doc = new Document({
    creator: "SignalCore",
    title: output.title,
    description: "Generated by SignalCore",
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1080,
              right: 1080,
              bottom: 1080,
              left: 1080,
            },
          },
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

function fallbackSlides(output: StoredOutput): SlidePlan[] {
  const data = output.data || {};
  const slides: SlidePlan[] = [
    {
      title: output.title,
      key_message: clean(data.summary) || "Evidence-based project review",
      bullets: [],
    },
  ];

  const findings = Array.isArray(data.findings) ? data.findings : [];
  for (const finding of findings) {
    slides.push({
      title: clean(finding.title) || "Finding",
      key_message: clean(finding.why_it_matters),
      bullets: clean(finding.recommended_action)
        ? [clean(finding.recommended_action)]
        : [],
      evidence_refs: finding.evidence_refs || [],
    });
  }

  const actions = Array.isArray(data.next_actions)
    ? data.next_actions.map(String).filter(Boolean)
    : [];
  if (actions.length) {
    slides.push({
      title: "Next Steps",
      key_message: "Recommended actions based on the evidence reviewed.",
      bullets: actions,
    });
  }

  return slides;
}

export async function renderPptx(output: StoredOutput) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "SignalCore";
  pptx.company = "SignalCore";
  pptx.subject = output.title;
  pptx.title = output.title;
  pptx.lang = "en-US";
  pptx.theme = {
    headFontFace: "Arial",
    bodyFontFace: "Arial",
    lang: "en-US",
  };

  const contractSlides = output.data?.deliverable_contract?.slides;
  const slides =
    Array.isArray(contractSlides) && contractSlides.length
      ? contractSlides
      : fallbackSlides(output);

  for (let index = 0; index < slides.length; index += 1) {
    const spec = slides[index] || {};
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };

    const title = clean(spec.title) || (index === 0 ? output.title : "SignalCore");
    slide.addText(title, {
      x: 0.7,
      y: 0.55,
      w: 11.9,
      h: 0.7,
      fontFace: "Arial",
      fontSize: index === 0 ? 30 : 27,
      bold: true,
      color: "111827",
      margin: 0,
    });

    const keyMessage = clean(spec.key_message);
    if (keyMessage) {
      slide.addText(keyMessage, {
        x: 0.75,
        y: 1.55,
        w: 11.5,
        h: 2.1,
        fontFace: "Arial",
        fontSize: index === 0 ? 20 : 18,
        color: "374151",
        margin: 0,
        valign: "top",
        fit: "shrink",
      });
    }

    const bullets = Array.isArray(spec.bullets)
      ? spec.bullets.map(String).filter(Boolean).slice(0, 7)
      : [];

    if (bullets.length) {
      slide.addText(
        bullets.map((item) => "• " + item).join("\n"),
        {
          x: 0.95,
          y: keyMessage ? 4.0 : 1.7,
          w: 10.9,
          h: keyMessage ? 2.25 : 4.6,
          fontFace: "Arial",
          fontSize: 17,
          color: "111827",
          fit: "shrink",
          valign: "top",
          margin: 0,
        },
      );
    }

    const evidence = Array.isArray(spec.evidence_refs)
      ? spec.evidence_refs.map(String).filter(Boolean).slice(0, 4)
      : [];
    if (evidence.length) {
      slide.addText("Evidence: " + evidence.join(" · "), {
        x: 0.75,
        y: 7.05,
        w: 11.4,
        h: 0.25,
        fontFace: "Arial",
        fontSize: 9,
        color: "6B7280",
        margin: 0,
        fit: "shrink",
      });
    }
  }

  const buffer = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  return Buffer.from(buffer);
}
