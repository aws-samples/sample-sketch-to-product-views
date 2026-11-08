#!/usr/bin/env bash
# Bundles the Lambdas, plans, asks before applying, then publishes the SPA.
#
#   ./deploy.sh <config> [--config-dir DIR] [--plan-only] [--yes] [-- <plan args>]
#
# `config` picks infra/envs/dev/<config>.tfvars and backend/<config>.s3.tfbackend (copy the
# *.example.tfvars and backend/example.s3.tfbackend first). `--config-dir` reads DIR/<config>.tfvars and DIR/<config>.s3.tfbackend instead, for
# an account whose details stay out of the repo. Credentials come from the caller's environment
# (AWS_PROFILE); the script prints the account it is about to change and applies only the plan it
# showed. `--yes` skips the prompt, which is required when there is no terminal to answer it.
set -euo pipefail

account='' config_dir='' plan_only=false yes=false
extra=()
while (($#)); do
  case "$1" in
    --config-dir)
      [[ -n "${2:-}" && "$2" != -* ]] || { echo "--config-dir needs a directory" >&2; exit 2; }
      config_dir="$2"; shift ;;
    --plan-only) plan_only=true ;;
    --yes) yes=true ;;
    --) shift; extra=("$@"); break ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) account="$1" ;;
  esac
  shift
done

[[ -n "$account" ]] || { echo "usage: deploy.sh <config> [options]; copy infra/envs/dev/openai-direct.example.tfvars to <config>.tfvars first" >&2; exit 2; }

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tf_dir="$root/infra/envs/dev"
if [[ -n "$config_dir" ]]; then
  config_dir="$(cd "$config_dir" && pwd)"
  tfvars="$config_dir/$account.tfvars"
  backend="$config_dir/$account.s3.tfbackend"
else
  tfvars="$tf_dir/$account.tfvars"
  backend="$tf_dir/backend/$account.s3.tfbackend"
fi
for f in "$tfvars" "$backend"; do
  [[ -f "$f" ]] || { echo "missing $f" >&2; exit 1; }
done
export AWS_REGION="${AWS_REGION:-us-east-1}"

caller="$(aws sts get-caller-identity --query '[Account,Arn]' --output text)"
echo "account: $caller"

# Terraform zips whatever is in each module's build/, so a stale bundle would ship silently.
npm run --prefix "$root" bundle:api
npm run --prefix "$root" bundle:pipeline

tf() { terraform -chdir="$tf_dir" "$@"; }
tf init -input=false -reconfigure -backend-config="$backend" >/dev/null

plan_args=(-input=false -var-file="$tfvars" ${extra[@]+"${extra[@]}"})
if $plan_only; then
  tf plan "${plan_args[@]}"
  exit 0
fi

plan="$(mktemp "${TMPDIR:-/tmp}/tfplan.XXXXXX")"
trap 'rm -f "$plan"' EXIT
# -detailed-exitcode: 0 means no changes, 2 means changes, anything else failed.
status=0
tf plan "${plan_args[@]}" -detailed-exitcode -out="$plan" || status=$?
((status == 0 || status == 2)) || exit "$status"

if ((status == 0)); then
  echo "no infrastructure changes"
else
  if ! $yes; then
    [[ -t 0 ]] || { echo "not applied: no terminal to confirm, re-run with --yes" >&2; exit 1; }
    read -r -p "Apply this plan to ${caller%%$'\t'*}? [y/N] " answer
    [[ "$answer" == [yY] ]] || { echo "not applied"; exit 1; }
  fi
  tf apply -input=false "$plan"
fi

# The SPA reads its config at build time; a missing value would silently disable sign-in.
cognito_url="$(tf output -raw hosted_ui_url)"
client_id="$(tf output -raw user_pool_client_id)"
web_bucket="$(tf output -raw web_bucket)"
dist_id="$(tf output -raw web_distribution_id)"
for v in "$cognito_url" "$client_id" "$web_bucket" "$dist_id"; do
  [[ -n "$v" ]] || { echo "missing a web output" >&2; exit 1; }
done
# Empty VITE_API_URL: the SPA calls /api/* on its own origin, through CloudFront and AWS WAF.
VITE_API_URL='' VITE_COGNITO_URL="$cognito_url" VITE_COGNITO_CLIENT_ID="$client_id" \
  npm run --prefix "$root" web:build
# Hashed assets are immutable; index.html must always be revalidated.
aws s3 sync "$root/web/dist" "s3://$web_bucket" --delete --exclude index.html \
  --cache-control "public,max-age=31536000,immutable"
aws s3 cp "$root/web/dist/index.html" "s3://$web_bucket/index.html" --cache-control "no-cache"
aws cloudfront create-invalidation --distribution-id "$dist_id" --paths '/*' >/dev/null
echo "web: $(tf output -raw web_url)"
