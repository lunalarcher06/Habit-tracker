#!/usr/bin/env bash
# One-time Azure setup for Habit Buddy (ADR 8).
# Run this once while signed in with your own Azure account (`az login`).
# After that, deployments are handled automatically by `.github/workflows/deploy.yml`
# on every push to `main`, which updates the Container Apps and uploads the UI.
#
# Use with: bash infra/azure-setup.sh
# It asks for the passwords when you run it, and nothing is saved in the repo or printed out.
set -euo pipefail

PREFIX=lalarcher-ieu2024
RG=rg-$PREFIX
LOC=francecentral                              
REPO=lunalarcher06/Habit-tracker               
OWNER=lunalarcher06                            
UI_STORAGE=lalarcherieu2024ui                  
SQL=$PREFIX-sql
ENV_NAME=$PREFIX-env
PLACEHOLDER=mcr.microsoft.com/k8se/quickstart:latest  


ask() { local v; read -r -s -p "$1: " v; echo >&2; printf '%s' "$v"; }
echo "Passwords: at least 12 characters with upper-case, lower-case letters and digits (no symbols)."
SQL_ADMIN_PW=${SQL_ADMIN_PW:-$(ask "SQL admin password")}
HABITS_DB_PW=${HABITS_DB_PW:-$(ask "habits_user password")}
STREAKS_DB_PW=${STREAKS_DB_PW:-$(ask "streaks_user password")}
JWT_SECRET=${JWT_SECRET:-$(openssl rand -hex 32)}         

echo "== 1. Providers (the first time this takes a few minutes)"
for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.Sql Microsoft.Storage Microsoft.ManagedIdentity; do
  az provider register --namespace $ns --wait
done
az extension add --name containerapp --upgrade --only-show-errors

echo "== 2. Resource group"
az group create -n $RG -l $LOC -o none

echo "== 3. UI: storage account with a static website"
az storage account create -n $UI_STORAGE -g $RG -l $LOC --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 -o none
az storage blob service-properties update --account-name $UI_STORAGE --auth-mode key \
  --static-website --index-document index.html --404-document index.html -o none
UI_URL=$(az storage account show -n $UI_STORAGE -g $RG --query primaryEndpoints.web -o tsv)
UI_ORIGIN=${UI_URL%/}                           # CORS origin: no trailing slash
echo "   UI: $UI_URL"

echo "== 4. SQL server and one free serverless database per service"
az sql server create -n $SQL -g $RG -l $LOC --admin-user sqladmin --admin-password "$SQL_ADMIN_PW" -o none
az sql server firewall-rule create -g $RG -s $SQL -n AllowAzureServices \
  --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0 -o none
for db in habits streaks; do
  az sql db create -g $RG -s $SQL -n $PREFIX-$db-db \
    --edition GeneralPurpose --compute-model Serverless --family Gen5 \
    --min-capacity 0.5 --capacity 1 --backup-storage-redundancy Local \
    --use-free-limit true --free-limit-exhaustion-behavior AutoPause -o none
done

echo "== 5. One user per database (no access to the other one)"
MYIP=$(curl -s https://api.ipify.org)
az sql server firewall-rule create -g $RG -s $SQL -n SetupOnly --start-ip-address "$MYIP" --end-ip-address "$MYIP" -o none
export SQLCMDPASSWORD="$SQL_ADMIN_PW"
sqlcmd -S tcp:$SQL.database.windows.net,1433 -d $PREFIX-habits-db -U sqladmin -b -Q \
  "IF USER_ID('habits_user') IS NULL CREATE USER habits_user WITH PASSWORD = '$HABITS_DB_PW'; ALTER ROLE db_owner ADD MEMBER habits_user;"
sqlcmd -S tcp:$SQL.database.windows.net,1433 -d $PREFIX-streaks-db -U sqladmin -b -Q \
  "IF USER_ID('streaks_user') IS NULL CREATE USER streaks_user WITH PASSWORD = '$STREAKS_DB_PW'; ALTER ROLE db_owner ADD MEMBER streaks_user;"
unset SQLCMDPASSWORD
az sql server firewall-rule delete -g $RG -s $SQL -n SetupOnly -o none     

echo "== 6. Container Apps environment and the two apps (placeholder image for now)"
az containerapp env create -n $ENV_NAME -g $RG -l $LOC -o none
az containerapp create -n $PREFIX-habits -g $RG --environment $ENV_NAME --image $PLACEHOLDER \
  --ingress external --target-port 8001 --min-replicas 0 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
  --secrets db-url="mssql://habits_user:$HABITS_DB_PW@$SQL.database.windows.net:1433/$PREFIX-habits-db" jwt-secret="$JWT_SECRET" \
  --env-vars DATABASE_URL=secretref:db-url JWT_SECRET=secretref:jwt-secret UI_ORIGIN=$UI_ORIGIN PORT=8001 -o none
HABITS_URL=https://$(az containerapp show -n $PREFIX-habits -g $RG --query properties.configuration.ingress.fqdn -o tsv)
az containerapp create -n $PREFIX-streaks -g $RG --environment $ENV_NAME --image $PLACEHOLDER \
  --ingress external --target-port 8002 --min-replicas 0 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
  --secrets db-url="mssql://streaks_user:$STREAKS_DB_PW@$SQL.database.windows.net:1433/$PREFIX-streaks-db" jwt-secret="$JWT_SECRET" \
  --env-vars DATABASE_URL=secretref:db-url JWT_SECRET=secretref:jwt-secret UI_ORIGIN=$UI_ORIGIN PORT=8002 \
             HABITS_URL=$HABITS_URL HABITS_TIMEOUT_S=3 -o none
STREAKS_URL=https://$(az containerapp show -n $PREFIX-streaks -g $RG --query properties.configuration.ingress.fqdn -o tsv)

echo "== 7. Managed identity for the pipeline: Contributor on this resource group only, main branch only"
az identity create -n $PREFIX-github -g $RG -l $LOC -o none
PRINCIPAL=$(az identity show -n $PREFIX-github -g $RG --query principalId -o tsv)
CLIENT_ID=$(az identity show -n $PREFIX-github -g $RG --query clientId -o tsv)
RG_ID=$(az group show -n $RG --query id -o tsv)
az role assignment create --assignee-object-id "$PRINCIPAL" --assignee-principal-type ServicePrincipal \
  --role Contributor --scope "$RG_ID" -o none
az identity federated-credential create --name github-main --identity-name $PREFIX-github -g $RG \
  --issuer https://token.actions.githubusercontent.com \
  --subject "repo:$REPO:ref:refs/heads/main" --audiences api://AzureADTokenExchange -o none

cat <<EOF

Done. Now in GitHub: Settings > Secrets and variables > Actions
  Secrets:    AZURE_CLIENT_ID=$CLIENT_ID
              AZURE_TENANT_ID=$(az account show --query tenantId -o tsv)
              AZURE_SUBSCRIPTION_ID=$(az account show --query id -o tsv)
  Variables:  PREFIX=$PREFIX  RESOURCE_GROUP=$RG  UI_STORAGE=$UI_STORAGE

Addresses
  UI (public_url): $UI_URL
  habits:          $HABITS_URL
  streaks:         $STREAKS_URL
EOF
