<#
.SYNOPSIS
  Let GitHub Actions (main branch only) roll out new images to the Retrolash
  container app, using OIDC federation. No client secret is created.

.DESCRIPTION
  Creates an Entra app registration + service principal, a federated
  credential for repo:<repo>:ref:refs/heads/main, and a Contributor role
  assignment scoped to the container app resource only (not the subscription
  or resource group). Run infra/deploy.ps1 first.

  Prints the four GitHub repository variables to add afterwards.
#>
param(
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [string] $ResourceGroup = 'rg-retrolash',
  [string] $Repo = 'flowersfx/retrolash',
  [string] $AppName = 'github-retrolash-deploy'
)

$ErrorActionPreference = 'Stop'
function Invoke-Az {
  & az @args
  if ($LASTEXITCODE -ne 0) { throw "az $($args -join ' ') failed ($LASTEXITCODE)" }
}

$tenantId = Invoke-Az account show --subscription $SubscriptionId --query tenantId -o tsv
$appScope = Invoke-Az resource show --name retrolash --resource-group $ResourceGroup `
  --resource-type Microsoft.App/containerApps --subscription $SubscriptionId --query id -o tsv

Write-Host "Tenant      : $tenantId"
Write-Host "Scope       : $appScope"
Write-Host "Trusts      : repo:${Repo}:ref:refs/heads/main"
$answer = Read-Host "Create app registration '$AppName' with Contributor on that container app only? [y/N]"
if ($answer -ne 'y') { exit 1 }

$clientId = Invoke-Az ad app list --display-name $AppName --query '[0].appId' -o tsv
if (-not $clientId) {
  $clientId = Invoke-Az ad app create --display-name $AppName --query appId -o tsv
}
$spExists = Invoke-Az ad sp list --filter "appId eq '$clientId'" --query '[0].id' -o tsv
if (-not $spExists) { Invoke-Az ad sp create --id $clientId -o none }

$credName = 'github-main'
$existing = Invoke-Az ad app federated-credential list --id $clientId --query "[?name=='$credName'].name" -o tsv
if (-not $existing) {
  $cred = @{
    name      = $credName
    issuer    = 'https://token.actions.githubusercontent.com'
    subject   = "repo:${Repo}:ref:refs/heads/main"
    audiences = @('api://AzureADTokenExchange')
  } | ConvertTo-Json -Compress
  $tmp = New-TemporaryFile
  Set-Content -Path $tmp -Value $cred
  Invoke-Az ad app federated-credential create --id $clientId --parameters "@$tmp" -o none
  Remove-Item $tmp
}

Invoke-Az role assignment create --assignee $clientId --role Contributor --scope $appScope -o none

Write-Host ''
Write-Host 'Add these as GitHub repository variables (Settings > Secrets and variables > Actions > Variables):'
Write-Host "  AZURE_CLIENT_ID       = $clientId"
Write-Host "  AZURE_TENANT_ID       = $tenantId"
Write-Host "  AZURE_SUBSCRIPTION_ID = $SubscriptionId"
Write-Host "  AZURE_RESOURCE_GROUP  = $ResourceGroup"
