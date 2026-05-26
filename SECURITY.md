# Security Policy

## Supported Versions

This repository is a live data feed. The only active version is the current state of the `main` branch.

## Reporting a Vulnerability

If you discover a security issue in this repository — including malicious stream URLs in the feed data, workflow vulnerabilities, or anything that could harm users of this project — please **do not open a public issue**.

Instead, report it privately via GitHub's built-in vulnerability reporting:

1. Go to the **Security** tab of this repository
2. Click **"Report a vulnerability"**
3. Describe the issue clearly, including steps to reproduce if applicable

You can expect an acknowledgement within **72 hours** and a resolution or status update within **7 days**.

## Scope

The following are in scope for security reports:

- Malicious or harmful URLs present in any feed file (`feeds/custom/`, `feeds/youtube/`)
- GitHub Actions workflow vulnerabilities that could allow unauthorized code execution or branch tampering
- Any content in the merged output that could be used to harm end users

## Out of Scope

- Dead or broken stream URLs — these are a data quality issue, not a security issue. Open a regular issue for those.
- Streams from iptv-org that are geo-blocked or legally restricted in your region — report those upstream to [iptv-org](https://github.com/iptv-org/iptv)
