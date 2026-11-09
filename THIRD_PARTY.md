# Third-party components and terms

This is not legal advice. Check these terms yourself before production use.

## Services

| Component | Where | Terms | Note |
| --- | --- | --- | --- |
| OpenAI GPT Image 2.6 and 2.5 | image generation | OpenAI's API terms; abuse-monitoring logs kept up to 30 days by default ([Your data](https://developers.openai.com/api/docs/guides/your-data)) | Get the design owner's approval before sending real designs. |
| Anthropic Claude and other models on Amazon Bedrock | analyser, critic | [Bedrock third-party model terms](https://aws.amazon.com/legal/bedrock/third-party-models/) | Claude models are billed through AWS Marketplace. |

## Packages

Licences read from each package's `package.json`. Run a licence scanner on the full dependency
tree before distribution.

| Package | Licence | Where |
| --- | --- | --- |
| `sharp` | Apache-2.0 | upload checks and fitting images to the critic's limits; vendored into the Lambda bundle |
| `@img/sharp-libvips-*` (libvips binary used by sharp) | LGPL-3.0-or-later | shipped in the pipeline Lambda bundle |
| `@aws/durable-execution-sdk-js` | Apache-2.0 | pipeline, CLI |
| AWS SDK for JavaScript v3 (`@aws-sdk/*`) | Apache-2.0 | shared, API |
| `react`, `react-dom` | MIT | web UI |
| `@xyflow/react` | MIT | web UI stage canvas |
| `vite`, `@vitejs/plugin-react` | MIT | web UI build (dev dependency) |
| `zod` | MIT | all packages |
| `yaml` | ISC | model registry |
| `esbuild`, `tsx`, `typescript` | MIT, MIT, Apache-2.0 | build and dev tooling |

## Marks in the documentation images

| Mark | Where | Note |
| --- | --- | --- |
| AWS Architecture Icons | `docs/architecture/*.png`, `site/media/overview.png` | From the official set ([AWS Architecture Icons](https://aws.amazon.com/architecture/icons/)), unmodified. |
| OpenAI wordmark | `docs/architecture/overview.png`, `site/media/overview.png` | Trademark of OpenAI, shown unmodified to name a supported provider ([OpenAI brand](https://openai.com/brand/)). |
| LiteLLM logo | `docs/architecture/overview.png`, `site/media/overview.png` | Trademark of its owner (BerriAI), shown unmodified to name a supported provider. |

