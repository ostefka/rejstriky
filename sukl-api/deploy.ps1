#!/usr/bin/env pwsh
# deploy.ps1 — Deploy SUKL API proxy to Azure Container Apps with NAT Gateway + Managed Identity
#
# Usage:
#   $env:AZURE_CONFIG_DIR = "c:\Users\ostefka\OneDrive\!vscode\SUKL\.azure-cli"
#   .\deploy.ps1

param(
    [string]$ResourceGroup = "rg-sukl-api",
    [string]$Location = "swedencentral",
    [string]$Subscription = "683d4859-a841-435a-90d1-0876db6f103f",

    # Names
    [string]$AcrName = "acrdomcp",                       # Reuse existing ACR
    [string]$AcrRg = "rg-ado-mcp-swedencentral",         # ACR resource group
    [string]$VnetName = "vnet-sukl-api",
    [string]$SubnetName = "snet-containerapps",
    [string]$NatGwName = "natgw-sukl-api",
    [string]$PublicIpName = "pip-sukl-api",
    [string]$EnvName = "cae-sukl-api",
    [string]$AppName = "ca-sukl-api",
    [string]$ImageTag = "v1.0.0",

    # AI Search config
    [string]$SearchEndpoint = "https://search-airlift-s1.search.windows.net",
    [string]$SearchServiceName = "search-airlift-s1",
    [string]$SearchServiceRg = "rg-airlift-rag",

    # Proxy API key (M365 Copilot sends this to authenticate)
    [string]$ProxyApiKey = ""
)

$ErrorActionPreference = "Stop"
$image = "$AcrName.azurecr.io/sukl-api:$ImageTag"

# Generate proxy API key if not provided
if (-not $ProxyApiKey) {
    $ProxyApiKey = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
    Write-Host "Generated PROXY_API_KEY: $ProxyApiKey" -ForegroundColor Magenta
    Write-Host "Save this key in SUKL Agent/env/.env.dev.user as SECRET_SUKL_API_KEY" -ForegroundColor Magenta
}

Write-Host "`n=== SUKL API Deployment ===" -ForegroundColor Cyan
Write-Host "Resource Group: $ResourceGroup"
Write-Host "Location:       $Location"
Write-Host "Image:          $image"

# ------------------------------------------------------------------
# 0. Select subscription
# ------------------------------------------------------------------
Write-Host "`n[0/9] Setting subscription..." -ForegroundColor Yellow
az account set --subscription $Subscription

# ------------------------------------------------------------------
# 1. Resource group
# ------------------------------------------------------------------
Write-Host "`n[1/9] Creating resource group..." -ForegroundColor Yellow
az group create --name $ResourceGroup --location $Location -o none

# ------------------------------------------------------------------
# 2. Build and push container image
# ------------------------------------------------------------------
Write-Host "`n[2/9] Building and pushing container image..." -ForegroundColor Yellow
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
az acr build `
    --registry $AcrName `
    --resource-group $AcrRg `
    --image "sukl-api:$ImageTag" `
    --file "$scriptDir/Dockerfile" `
    "$scriptDir" `
    -o none

Write-Host "  Image pushed: $image" -ForegroundColor Green

# ------------------------------------------------------------------
# 3. Create VNet with subnet for Container Apps
# ------------------------------------------------------------------
Write-Host "`n[3/9] Creating VNet and subnet..." -ForegroundColor Yellow
az network vnet create `
    --resource-group $ResourceGroup `
    --name $VnetName `
    --location $Location `
    --address-prefixes "10.0.0.0/16" `
    --subnet-name $SubnetName `
    --subnet-prefixes "10.0.0.0/23" `
    -o none

# Container Apps needs at least /23 and delegation
az network vnet subnet update `
    --resource-group $ResourceGroup `
    --vnet-name $VnetName `
    --name $SubnetName `
    --delegations "Microsoft.App/environments" `
    -o none

Write-Host "  VNet: $VnetName, Subnet: $SubnetName (10.0.0.0/23)" -ForegroundColor Green

# ------------------------------------------------------------------
# 4. Create NAT Gateway with static public IP
# ------------------------------------------------------------------
Write-Host "`n[4/9] Creating NAT Gateway with static public IP..." -ForegroundColor Yellow

az network public-ip create `
    --resource-group $ResourceGroup `
    --name $PublicIpName `
    --location $Location `
    --sku Standard `
    --allocation-method Static `
    --zone 1 2 3 `
    -o none

$staticIp = az network public-ip show `
    --resource-group $ResourceGroup `
    --name $PublicIpName `
    --query "ipAddress" -o tsv

Write-Host "  Static IP: $staticIp" -ForegroundColor Green

az network nat gateway create `
    --resource-group $ResourceGroup `
    --name $NatGwName `
    --location $Location `
    --public-ip-addresses $PublicIpName `
    --idle-timeout 10 `
    -o none

# Associate NAT Gateway with subnet
az network vnet subnet update `
    --resource-group $ResourceGroup `
    --vnet-name $VnetName `
    --name $SubnetName `
    --nat-gateway $NatGwName `
    -o none

Write-Host "  NAT Gateway: $NatGwName -> $staticIp" -ForegroundColor Green

# ------------------------------------------------------------------
# 5. Create Container Apps Environment with VNet
# ------------------------------------------------------------------
Write-Host "`n[5/9] Creating Container Apps Environment..." -ForegroundColor Yellow

$subnetId = az network vnet subnet show `
    --resource-group $ResourceGroup `
    --vnet-name $VnetName `
    --name $SubnetName `
    --query "id" -o tsv

az containerapp env create `
    --resource-group $ResourceGroup `
    --name $EnvName `
    --location $Location `
    --infrastructure-subnet-resource-id $subnetId `
    --internal-only false `
    -o none

Write-Host "  Environment: $EnvName (VNet-integrated)" -ForegroundColor Green

# ------------------------------------------------------------------
# 6. Get ACR credentials
# ------------------------------------------------------------------
Write-Host "`n[6/9] Getting ACR credentials..." -ForegroundColor Yellow

$acrUser = az acr credential show --name $AcrName --resource-group $AcrRg --query "username" -o tsv
$acrPass = az acr credential show --name $AcrName --resource-group $AcrRg --query "passwords[0].value" -o tsv

# ------------------------------------------------------------------
# 7. Deploy Container App with system-assigned managed identity
# ------------------------------------------------------------------
Write-Host "`n[7/9] Deploying Container App..." -ForegroundColor Yellow

az containerapp create `
    --resource-group $ResourceGroup `
    --name $AppName `
    --environment $EnvName `
    --image $image `
    --registry-server "$AcrName.azurecr.io" `
    --registry-username $acrUser `
    --registry-password $acrPass `
    --target-port 8000 `
    --ingress external `
    --min-replicas 1 `
    --max-replicas 1 `
    --cpu 0.25 `
    --memory 0.5Gi `
    --system-assigned `
    --env-vars "SEARCH_ENDPOINT=$SearchEndpoint" "PROXY_API_KEY=secretref:proxy-api-key" `
    --secrets "proxy-api-key=$ProxyApiKey" `
    -o none

$fqdn = az containerapp show `
    --resource-group $ResourceGroup `
    --name $AppName `
    --query "properties.configuration.ingress.fqdn" -o tsv

Write-Host "  App URL: https://$fqdn" -ForegroundColor Green

# ------------------------------------------------------------------
# 8. Assign Search Index Data Reader role to managed identity
# ------------------------------------------------------------------
Write-Host "`n[8/9] Assigning Search Index Data Reader role to managed identity..." -ForegroundColor Yellow

$principalId = az containerapp show `
    --resource-group $ResourceGroup `
    --name $AppName `
    --query "identity.principalId" -o tsv

$searchResourceId = az search service show `
    --name $SearchServiceName `
    --resource-group $SearchServiceRg `
    --query "id" -o tsv

# Search Index Data Reader = 1407120a-92aa-4202-b7e9-c0e197c71c8f
az role assignment create `
    --assignee-object-id $principalId `
    --assignee-principal-type ServicePrincipal `
    --role "1407120a-92aa-4202-b7e9-c0e197c71c8f" `
    --scope $searchResourceId `
    -o none

Write-Host "  Assigned Search Index Data Reader to $principalId" -ForegroundColor Green

# ------------------------------------------------------------------
# 9. Add static IP to AI Search firewall
# ------------------------------------------------------------------
Write-Host "`n[9/9] Adding static IP to AI Search firewall..." -ForegroundColor Yellow

# Get current firewall rules
$currentRules = az search service show `
    --name $SearchServiceName `
    --resource-group $SearchServiceRg `
    --query "networkRuleSet.ipRules[].value" -o tsv

$alreadyWhitelisted = $currentRules -split "`n" | Where-Object { $_.Trim() -eq $staticIp }

if ($alreadyWhitelisted) {
    Write-Host "  IP $staticIp already in firewall rules" -ForegroundColor Green
} else {
    # Build new IP rules array — keep existing + add new
    $existingIps = $currentRules -split "`n" | Where-Object { $_.Trim() }
    $allIps = @($existingIps) + @($staticIp)
    $ipRulesArray = $allIps | ForEach-Object { @{ value = $_.Trim() } }
    $body = @{ properties = @{ networkRuleSet = @{ ipRules = $ipRulesArray } } } | ConvertTo-Json -Depth 5 -Compress

    az rest --method PATCH `
        --url "https://management.azure.com/subscriptions/$Subscription/resourceGroups/$SearchServiceRg/providers/Microsoft.Search/searchServices/$SearchServiceName`?api-version=2024-06-01-preview" `
        --body $body `
        -o none

    Write-Host "  Added $staticIp to AI Search firewall" -ForegroundColor Green
}

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
Write-Host "`n=== Deployment Complete ===" -ForegroundColor Cyan
Write-Host "  App URL:      https://$fqdn"
Write-Host "  Static IP:    $staticIp"
Write-Host "  Health check: https://$fqdn/health"
Write-Host ""
Write-Host "`nNext steps:" -ForegroundColor Yellow
Write-Host "  1. Update SUKL Agent/env/.env.dev:    SUKL_API_HOSTNAME=$fqdn"
Write-Host "  2. Update SUKL Agent/env/.env.dev.user: SECRET_SUKL_API_KEY=$ProxyApiKey"
Write-Host "  3. Re-provision agent: cd 'SUKL Agent' && teamsapp provision --env dev"
Write-Host ""
Write-Host "Test:" -ForegroundColor Yellow
Write-Host "  curl https://$fqdn/health"
Write-Host "  curl -H 'api-key: $ProxyApiKey' `"https://$fqdn/api/drugs/search?q=ibuprofen`""
Write-Host "  curl -H 'api-key: $ProxyApiKey' `"https://$fqdn/api/pharmacies/search?city=Praha&emergency=true`""
