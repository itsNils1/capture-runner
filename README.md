# capture-runner

Records scripted headless Chrome sessions to MP4 on GitHub Actions.

A job is started with `workflow_dispatch`. The runner fetches the job spec from `JOB_SPEC_URL`, opens the pages it describes, captures every frame through the page script in the spec, encodes the segments with ffmpeg and uploads the joined MP4.

## Secrets

- `JOB_SPEC_URL`: endpoint that returns the job spec
- `JOB_TOKEN`: token sent as `x-job-token` on every request to that server
