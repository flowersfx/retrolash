<#
.SYNOPSIS
  Let GitHub Actions (main branch only) roll out new images to the Retrolash
  container app, using OIDC federation. No client secret is created.

.DESCRIPTION
  Creates an Entra app registration + service principal in the tenant that
  owns -SubscriptionId, a federated credential for
  repo:<repo>:ref:refs/heads/main, and a Contributor role assignment scoped to
  the container app resource only (not the subscription or resource group).
  Run infra/deploy.ps1 first.

  `az ad` commands act on the tenant of the az *default* subscription, so this
  script switches the default to -SubscriptionId while it runs and switches it
  back afterwards.

  Prints the four GitHub repository variables to add afterwards.
#>
param(
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [string] $ResourceGroup = 'rg-retrolash',
  [string] $Repo = 'flowersfx/retrolash',
  [string] $AppName = 'github-retrolash-deploy',
  [switch] $Yes
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
if (-not $Yes) {
  $answer = Read-Host "Create app registration '$AppName' with Contributor on that container app only? [y/N]"
  if ($answer -ne 'y') { exit 1 }
}

$previous = Invoke-Az account show --query id -o tsv
Invoke-Az account set --subscription $SubscriptionId
try {
  $active = Invoke-Az account show --query tenantId -o tsv
  if ($active -ne $tenantId) { throw "Active tenant is $active, expected $tenantId; refusing to touch Entra." }

  $clientId = Invoke-Az ad app list --display-name $AppName --query '[0].appId' -o tsv
  if (-not $clientId) {
    $clientId = Invoke-Az ad app create --display-name $AppName --sign-in-audience AzureADMyOrg --query appId -o tsv
    Write-Host "Created app registration $clientId"
  } else {
    Write-Host "Reusing app registration $clientId"
  }

  $spId = Invoke-Az ad sp list --filter "appId eq '$clientId'" --query '[0].id' -o tsv
  if (-not $spId) {
    $spId = Invoke-Az ad sp create --id $clientId --query id -o tsv
  }

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
    try { Invoke-Az ad app federated-credential create --id $clientId --parameters "@$tmp" -o none }
    finally { Remove-Item $tmp }
  }

  $hasRole = Invoke-Az role assignment list --assignee $spId --scope $appScope --role Contributor `
    --subscription $SubscriptionId --query '[0].id' -o tsv
  if (-not $hasRole) {
    # The service principal can take a few seconds to replicate.
    for ($i = 1; $i -le 6; $i++) {
      & az role assignment create --assignee-object-id $spId --assignee-principal-type ServicePrincipal `
        --role Contributor --scope $appScope --subscription $SubscriptionId -o none
      if ($LASTEXITCODE -eq 0) { break }
      if ($i -eq 6) { throw 'Role assignment failed.' }
      Start-Sleep -Seconds 10
    }
  }
}
finally {
  Invoke-Az account set --subscription $previous
}

Write-Host ''
Write-Host 'Add these as GitHub repository variables (Settings > Secrets and variables > Actions > Variables):'
Write-Host "  AZURE_CLIENT_ID       = $clientId"
Write-Host "  AZURE_TENANT_ID       = $tenantId"
Write-Host "  AZURE_SUBSCRIPTION_ID = $SubscriptionId"
Write-Host "  AZURE_RESOURCE_GROUP  = $ResourceGroup"
