# Security Policy

Thank you for helping keep DeployOnTime and its users safe.

## Supported versions

DeployOnTime is published one part at a time. Security fixes go into the latest code on the `main` branch, so please update to the latest `main` before reporting, in case the problem is already fixed.

| Part | Supported |
| --- | --- |
| Machine queue (`dotime-queue`), latest `main` | Yes |
| Older commits | No |

## Reporting a vulnerability

Please **do not** report security problems in a public issue, discussion or pull request.

Report them privately instead:

1. Open the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Fill in the form. Only you and the maintainer can see it.

It helps a lot if you include:

- What the problem is and what someone could do with it
- Steps to reproduce it, or a small proof of concept
- Your operating system (macOS or Linux, with its version), Node and git versions, and the commit you tested
- Any idea you have for a fix

## What to expect

DeployOnTime is maintained by one person, so these are goals rather than guarantees:

- A reply confirming your report within 3 business days
- A first assessment within 7 days
- Updates as the fix progresses
- Once fixed, a published GitHub security advisory that credits you, unless you would rather stay anonymous

Please allow reasonable time for a fix before sharing details publicly. The aim is to agree on a disclosure date with you, within 90 days of your report.

## Scope

In scope: problems in DeployOnTime's own code, for example:

- A label, flag, setting or file that makes `dotime-queue` run something the user did not ask for
- The time limit or the reaper stopping processes it was not meant to stop
- Reading or writing files outside `~/.dotime`, or unsafe handling of files inside it (such as symlink tricks)
- Secrets from commands or environment variables leaking into the journal, history or other saved state
- Another user on the same computer being able to read or change the queue's state

Out of scope:

- Problems in the commands you run through the queue
- Problems in Node.js, git, macOS or Linux themselves (please report those to their own projects)
- Attacks that need someone to already control your user account
- The queue working as designed, such as jobs waiting, time limits or the retry block (open a normal issue if the behavior seems wrong)

## Good-faith research

If you research and report in good faith under this policy, no legal action will be taken against you. Please only test on your own computer and data, and do not access or change other people's data.
