#!/usr/bin/fish
auto-browser run --goal "打开 Gmail 并检查收件箱" --planner-model vapi/gpt-5.4-nano --executor-model vapi/gpt-4o-mini --executable-path "/usr/bin/google-chrome-stable" --profile-path "$HOME/.cache/auto-browser/profiles/google-chrome-default-copy"
