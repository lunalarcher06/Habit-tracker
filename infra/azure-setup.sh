#!/usr/bin/env bash
# One-time Azure setup for Habit Buddy (ADR 8).
# Run this once while signed in with your own Azure account (`az login`).
# After that, deployments are handled automatically by `.github/workflows/deploy.yml`
# on every push to `main`, which updates the Container Apps and uploads the UI.
#
# Use with: bash infra/azure-setup.sh
# It asks for the passwords when you run it, and nothing is saved in the repo or printed out.
set -euo pipefail
# Safe to run again: anything that already exists is skipped.
# If the free database offer is refused in this region, run it with FREE_DB=false:
# plain serverless databases that pause after 60 minutes (billed only while they run).

PREFIX=lalarcher-ieu2024
RG=rg-$PREFIX
LOC=spaincentral                               # one of the five regions this Azure for Students subscription allows (see its policy)
REPO=lunalarcher06/Habit-tracker               
# GitHub's OIDC token names the repository with its owner and repository IDs
# (the "subject claim" in the azure/login log): repo:<owner>@<owner id>/<repo>@<repo id>:ref:refs/heads/main
OIDC_SUBJECT="repo:lunalarcher06@232092257/Habit-tracker@1397831498:ref:refs/heads/main"
OWNER=lunalarcher06                            
UI_STORAGE=lalarcherieu2024ui                  
SQL=$PREFIX-sql
ENV_NAME=$PREFIX-env
PLACEHOLDER=mcr.microsoft.com/k8se/quickstart:latest  


exists() { "$@" -o none >/dev/null 2>&1; }      # true if the az show command finds the resource
ask() { local v; read -r -s -p "$1: " v; echo >&2; printf '%s' "$v"; }
# Checks a password without showing it: Azure SQL wants upper, lower and digits; symbols would break DATABASE_URL.
check_pw() {
  local name=$1 v=$2 n=${#2}
  echo "   $name: $n characters" >&2
  [ $n -ge 12 ]                  || { echo "   $name is too short (or the paste did not go in): need 12+" >&2; exit 1; }
  [[ $v =~ ^[A-Za-z0-9]+$ ]]     || { echo "   $name has symbols or spaces: use letters and digits only" >&2; exit 1; }
  [[ $v =~ [A-Z] && $v =~ [a-z] && $v =~ [0-9] ]] || { echo "   $name needs an upper-case letter, a lower-case letter and a digit" >&2; exit 1; }
}
echo "Passwords: at least 12 characters with upper-case, lower-case letters and digits (no symbols)."
SQL_ADMIN_PW=${SQL_ADMIN_PW:-$(ask "SQL admin password")}
HABITS_DB_PW=${HABITS_DB_PW:-$(ask "habits_user password")}
STREAKS_DB_PW=${STREAKS_DB_PW:-$(ask "streaks_user password")}
JWT_SECRET=${JWT_SECRET:-$(openssl rand -hex 32)}
check_pw "SQL admin password" "$SQL_ADMIN_PW"
check_pw "habits_user password" "$HABITS_DB_PW"
check_pw "streaks_user password" "$STREAKS_DB_PW"         

# Azure is eventually consistent: just after a resource is created or changed, a request can
# briefly answer "not found". Every az call in the steps below retries a few times.
azr() {
  local i
  for i in 1 2 3 4 5; do
    az "$@" && return 0
    [ $i -lt 5 ] && { echo "   (Azure not ready yet, retrying in 15 s)" >&2; sleep 15; }
  done
  return 1
}
az account set --subscription "Azure for Students"      # never the other subscription
echo "Subscription: $(az account show --query name -o tsv)"

echo "== 1. Providers (the first time this takes a few minutes)"
for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.Sql Microsoft.Storage Microsoft.ManagedIdentity; do
  azr provider register --namespace $ns --wait
done
azr extension add --name containerapp --upgrade --only-show-errors

echo "== 2. Resource group"
azr group create -n $RG -l $LOC -o none

echo "== 3. UI: storage account with a static website"
azr storage account create -n $UI_STORAGE -g $RG -l $LOC --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 -o none
azr storage blob service-properties update --account-name $UI_STORAGE --auth-mode key \
  --static-website --index-document index.html --404-document index.html -o none
UI_URL=$(azr storage account show -n $UI_STORAGE -g $RG --query primaryEndpoints.web -o tsv)
UI_ORIGIN=${UI_URL%/}                           # CORS origin: no trailing slash
echo "   UI: $UI_URL"

echo "== 4. SQL server and one free serverless database per service"
exists az sql server show -n $SQL -g $RG ||
  azr sql server create -n $SQL -g $RG -l $LOC --admin-user sqladmin --admin-password "$SQL_ADMIN_PW" -o none
azr sql server firewall-rule create -g $RG -s $SQL -n AllowAzureServices \
  --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0 -o none
if [ "${FREE_DB:-true}" = true ]; then
  # the free offer sets its own minimum, auto-pause delay and size (Microsoft's example uses a maximum of 2 vCores)
  SIZE=(--capacity 2 --use-free-limit true --free-limit-exhaustion-behavior AutoPause)
else
  SIZE=(--capacity 1 --min-capacity 0.5 --auto-pause-delay 60 --max-size 2GB)
fi
for db in habits streaks; do
  exists az sql db show -g $RG -s $SQL -n $PREFIX-$db-db ||
    azr sql db create -g $RG -s $SQL -n $PREFIX-$db-db \
      --edition GeneralPurpose --compute-model Serverless --family Gen5 \
      --backup-storage-redundancy Local --zone-redundant false "${SIZE[@]}" -o none
done

echo "== 5. One user per database (no access to the other one)"
MYIP=$(curl -s https://api.ipify.org)
NET=${MYIP%.*}                                   # some networks leave through several addresses: allow the /24 while setting up
azr sql server firewall-rule create -g $RG -s $SQL -n SetupOnly --start-ip-address "$NET.0" --end-ip-address "$NET.255" -o none
sleep 30                                         # a new firewall rule can take a moment to apply
export SQLCMDPASSWORD="$SQL_ADMIN_PW"
sqlcmd -S tcp:$SQL.database.windows.net,1433 -d $PREFIX-habits-db -U sqladmin -b -Q \
  "IF USER_ID('habits_user') IS NULL CREATE USER habits_user WITH PASSWORD = '$HABITS_DB_PW'; ALTER ROLE db_owner ADD MEMBER habits_user;"
sqlcmd -S tcp:$SQL.database.windows.net,1433 -d $PREFIX-streaks-db -U sqladmin -b -Q \
  "IF USER_ID('streaks_user') IS NULL CREATE USER streaks_user WITH PASSWORD = '$STREAKS_DB_PW'; ALTER ROLE db_owner ADD MEMBER streaks_user;"
unset SQLCMDPASSWORD
azr sql server firewall-rule delete -g $RG -s $SQL -n SetupOnly -o none     

echo "== 6. Container Apps environment and the two apps (placeholder image for now)"
exists az containerapp env show -n $ENV_NAME -g $RG ||
  azr containerapp env create -n $ENV_NAME -g $RG -l $LOC -o none
exists az containerapp show -n $PREFIX-habits -g $RG ||
azr containerapp create -n $PREFIX-habits -g $RG --environment $ENV_NAME --image $PLACEHOLDER \
  --ingress external --target-port 8001 --min-replicas 0 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
  --secrets db-url="mssql://habits_user:$HABITS_DB_PW@$SQL.database.windows.net:1433/$PREFIX-habits-db" jwt-secret="$JWT_SECRET" \
  --env-vars DATABASE_URL=secretref:db-url JWT_SECRET=secretref:jwt-secret UI_ORIGIN=$UI_ORIGIN PORT=8001 -o none
HABITS_URL=https://$(azr containerapp show -n $PREFIX-habits -g $RG --query properties.configuration.ingress.fqdn -o tsv)
exists az containerapp show -n $PREFIX-streaks -g $RG ||
azr containerapp create -n $PREFIX-streaks -g $RG --environment $ENV_NAME --image $PLACEHOLDER \
  --ingress external --target-port 8002 --min-replicas 0 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
  --secrets db-url="mssql://streaks_user:$STREAKS_DB_PW@$SQL.database.windows.net:1433/$PREFIX-streaks-db" jwt-secret="$JWT_SECRET" \
  --env-vars DATABASE_URL=secretref:db-url JWT_SECRET=secretref:jwt-secret UI_ORIGIN=$UI_ORIGIN PORT=8002 \
             HABITS_URL=$HABITS_URL HABITS_TIMEOUT_S=3 -o none
STREAKS_URL=https://$(azr containerapp show -n $PREFIX-streaks -g $RG --query properties.configuration.ingress.fqdn -o tsv)

echo "== 7. Managed identity for the pipeline: Contributor on this resource group only, main branch only"
azr identity create -n $PREFIX-github -g $RG -l $LOC -o none
PRINCIPAL=$(azr identity show -n $PREFIX-github -g $RG --query principalId -o tsv)
CLIENT_ID=$(azr identity show -n $PREFIX-github -g $RG --query clientId -o tsv)
RG_ID=$(azr group show -n $RG --query id -o tsv)
[ -n "$(azr role assignment list --assignee "$PRINCIPAL" --scope "$RG_ID" --role Contributor --query '[0].id' -o tsv)" ] ||
azr role assignment create --assignee-object-id "$PRINCIPAL" --assignee-principal-type ServicePrincipal \
  --role Contributor --scope "$RG_ID" -o none
azr identity federated-credential create --name github-main --identity-name $PREFIX-github -g $RG \
  --issuer https://token.actions.githubusercontent.com \
  --subject "$OIDC_SUBJECT" --audiences api://AzureADTokenExchange -o none

cat <<EOF

Done. Now in GitHub: Settings > Secrets and variables > Actions
  Secrets:    AZURE_CLIENT_ID=$CLIENT_ID
              AZURE_TENANT_ID=$(azr account show --query tenantId -o tsv)
              AZURE_SUBSCRIPTION_ID=$(azr account show --query id -o tsv)
  Variables:  PREFIX=$PREFIX  RESOURCE_GROUP=$RG  UI_STORAGE=$UI_STORAGE

Addresses
  UI (public_url): $UI_URL
  habits:          $HABITS_URL
  streaks:         $STREAKS_URL
EOF
