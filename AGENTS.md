# make.fun Multi-Bounty Architecture & Agent Guidelines

This repository (`CryptoExplor/make.fun`) is designed to host and manage multiple competitions and bounties from [make.fun](https://make.fun) in a clean, modular structure.

---

## 📁 Repository Structure

```text
make.fun/
├── AGENTS.md                  # This file: standards & guidelines for coding agents
├── README.md                  # Main repository overview & bounty index
├── LICENSE                    # MIT License
├── .gitignore                 # Strict ignores for private keys, claim codes, & bundles
├── .makefun/
│   └── owner.json             # make.fun account wallet verification
├── main.ts                    # Root container entrypoint for make.fun grader
├── entry.png                  # Active entry image for current visual bounty
└── <bounty-slug-folder>/      # Dedicated subfolder per bounty
    ├── README.md              # Bounty overview, instructions & deliverables
    ├── main.ts                # Subfolder program entrypoint
    ├── entries/               # Archive of past entry iterations & assets
    ├── claim-info.json        # [GITIGNORED] All submission IDs, claim codes & metadata
    ├── claim-code.txt         # [GITIGNORED] Private claim codes for prize withdrawal
    └── makefun-keypair.json   # [GITIGNORED] Local Solana keypair for CLI claim/signing
```

---

## 🤖 Guidelines for AI Agents Working on New Bounties

### 1. Bounty Isolation & Modular Subfolders
* Always place each competition's logic, assets, and documentation inside its own subfolder (e.g., `Make-the-AI-judge-happy/`).
* Never pollute the root folder with non-shared files. Keep the root strictly for global routing (`main.ts`), global config (`.gitignore`, `LICENSE`, `.makefun/owner.json`), and documentation (`README.md`, `AGENTS.md`).

### 2. make.fun Sandbox Entrypoint Compatibility
* The make.fun container grader evaluates the root of the repository (`/bot/main.ts` or `/bot/main.py`).
* Always configure the root `main.ts` (or `main.py`) to safely detect and route to the active bounty's program/output directory.

### 3. Protecting the `thinking_reproduces` Metric (>30% Authored Code)
* make.fun requires that the uploaded agent session transcripts account for **at least 30% of all counted code lines** in the entire git repository snapshot at the submitted commit.
* If a previous bounty contains thousands of lines of code without matching agent session transcripts, isolate or branch older bounties (e.g. via git branches or separate modular repositories) to ensure each submission maintains >30% (ideally >80%) verifiable agent authorship.

### 4. Security, Credentials & `.gitignore` Hard Stops
* **Never commit secrets**: Claim codes, API keys, private keypairs, and `.env` files must NEVER be staged or pushed to GitHub.
* Ensure `.gitignore` covers:
  ```gitignore
  claim-code.txt
  claim-info.json
  claim-instructions.txt
  CLAIM_INSTRUCTIONS.md
  *keypair*.json
  transcripts.tar.gz
  ```
* All claim codes and keypair files must remain local inside the corresponding bounty subfolder.

### 5. Standard Submission Workflow for Agents
1. **Develop & Verify**: Implement the deliverables, write tests, and run local validation.
2. **Commit & Push**: Commit with clean, conventional commit messages and push to `origin main` (or the competition branch).
3. **Bundle Transcripts**: Run `node cli/makefun.mjs bundle --repo <repo> --session <transcript-path> --model <model> --provider <provider> --out transcripts.tar.gz`.
4. **Pre-Flight Check**: Run `node cli/makefun.mjs check --repo <repo> --commit <sha> --transcripts transcripts.tar.gz` and ensure all 12 checks pass.
5. **Submit**: Run `node cli/makefun.mjs submit --competition <slug> --repo-url <url> --commit <sha> --title "<title>" --bundle transcripts.tar.gz --keypair <keypair>`.
6. **Save Claim Metadata**: Record the returned `submission_id` and `claim_code` in the bounty's `claim-info.json` and `claim-code.txt`.
