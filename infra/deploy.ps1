<#
.SYNOPSIS
  Create or update the Retrolash Azure resources (Container Apps + Azure Files).

.DESCRIPTION
  Always targets the subscription you pass in, never the az CLI default.
  Shows an ARM what-if preview first and asks before changing anything.

.EXAMPLE
  ./infra/deploy.ps1 -SubscriptionId <guid>              # preview, then confirm
  ./infra/deploy.ps1 -SubscriptionId <guid> -PreviewOnly # what-if only
#>
param(
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [string] $ResourceGroup = 'rg-retrolash',
  [string] $Location = 'swedencentral',
  [string] $Image = 'ghcr.io/flowersfx/retrolash:latest',
  [ValidateSet(0, 1)] [int] $MinReplicas = 0,
  [switch] $PreviewOnly
)

$ErrorActionPreference = 'Stop'
$template = Join-Path $PSScriptRoot 'main.bicep'

function Invoke-Az {
  & az @args
  if ($LASTEXITCODE -ne 0) { throw "az $($args -join ' ') failed ($LASTEXITCODE)" }
}

$sub = Invoke-Az account show --subscription $SubscriptionId --query '{name:name, tenant:tenantId}' -o json | ConvertFrom-Json
Write-Host "Subscription : $($sub.name)"
Write-Host "Resource grp : $ResourceGroup ($Location)"
Write-Host "Image        : $Image"
Write-Host ''

$rgExists = (Invoke-Az group exists --name $ResourceGroup --subscription $SubscriptionId) -eq 'true'
if (-not $rgExists) {
  if ($PreviewOnly) {
    Write-Host "Resource group $ResourceGroup does not exist yet; it would be created. (what-if needs it to exist, so stopping here.)"
    exit 0
  }
  $answer = Read-Host "Create resource group $ResourceGroup in $Location? [y/N]"
  if ($answer -ne 'y') { exit 1 }
  Invoke-Az group create --name $ResourceGroup --location $Location --subscription $SubscriptionId --tags app=retrolash -o none
}

$params = @("image=$Image", "minReplicas=$MinReplicas")

Write-Host '--- What-if preview ---'
Invoke-Az deployment group what-if --resource-group $ResourceGroup --subscription $SubscriptionId `
  --template-file $template --parameters @params
if ($PreviewOnly) { exit 0 }

$answer = Read-Host 'Apply these changes? [y/N]'
if ($answer -ne 'y') { Write-Host 'Nothing changed.'; exit 1 }

$out = Invoke-Az deployment group create --resource-group $ResourceGroup --subscription $SubscriptionId `
  --name "retrolash-$(Get-Date -Format yyyyMMdd-HHmmss)" `
  --template-file $template --parameters @params `
  --query properties.outputs -o json | ConvertFrom-Json

Write-Host ''
Write-Host "Retrolash is at: $($out.url.value)"
