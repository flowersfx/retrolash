<#
.SYNOPSIS
  Create or update the shared lab Azure AI Speech resource (rg-lab-shared).

.DESCRIPTION
  Always targets the subscription you pass in, never the az CLI default.
  Registers the Microsoft.CognitiveServices provider if needed, shows an ARM
  what-if preview first, and asks before changing anything.

.EXAMPLE
  ./infra/lab/deploy-speech.ps1 -SubscriptionId <guid>              # preview, then confirm
  ./infra/lab/deploy-speech.ps1 -SubscriptionId <guid> -PreviewOnly # what-if only
#>
param(
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [string] $ResourceGroup = 'rg-lab-shared',
  [string] $Location = 'swedencentral',
  [ValidateSet('F0', 'S0')] [string] $Sku = 'F0',
  [switch] $PreviewOnly,
  [switch] $Yes
)

$ErrorActionPreference = 'Stop'
$template = Join-Path $PSScriptRoot 'speech.bicep'

function Invoke-Az {
  & az @args
  if ($LASTEXITCODE -ne 0) { throw "az $($args -join ' ') failed ($LASTEXITCODE)" }
}
function Confirm-Step([string] $question) {
  if ($Yes) { return $true }
  return (Read-Host "$question [y/N]") -eq 'y'
}

$sub = Invoke-Az account show --subscription $SubscriptionId --query '{name:name, tenant:tenantId}' -o json | ConvertFrom-Json
Write-Host "Subscription : $($sub.name)"
Write-Host "Resource grp : $ResourceGroup ($Location)"
Write-Host "Speech SKU   : $Sku"
Write-Host ''

$state = Invoke-Az provider show -n Microsoft.CognitiveServices --subscription $SubscriptionId --query registrationState -o tsv
if ($state -ne 'Registered') {
  if ($PreviewOnly) { Write-Host "Provider Microsoft.CognitiveServices is $state; it would be registered." }
  elseif (Confirm-Step "Register resource provider Microsoft.CognitiveServices?") {
    Invoke-Az provider register -n Microsoft.CognitiveServices --subscription $SubscriptionId --wait -o none
  } else { exit 1 }
}

$rgExists = (Invoke-Az group exists --name $ResourceGroup --subscription $SubscriptionId) -eq 'true'
if (-not $rgExists) {
  if ($PreviewOnly) {
    Write-Host "Resource group $ResourceGroup does not exist yet; it would be created. (what-if needs it to exist, so stopping here.)"
    exit 0
  }
  if (-not (Confirm-Step "Create resource group $ResourceGroup in $Location?")) { exit 1 }
  Invoke-Az group create --name $ResourceGroup --location $Location --subscription $SubscriptionId --tags purpose=lab-shared -o none
}

Write-Host '--- What-if preview ---'
Invoke-Az deployment group what-if --resource-group $ResourceGroup --subscription $SubscriptionId `
  --template-file $template --parameters "sku=$Sku"
if ($PreviewOnly) { exit 0 }

if (-not (Confirm-Step 'Apply these changes?')) { Write-Host 'Nothing changed.'; exit 1 }

$out = Invoke-Az deployment group create --resource-group $ResourceGroup --subscription $SubscriptionId `
  --name "lab-speech-$(Get-Date -Format yyyyMMdd-HHmmss)" `
  --template-file $template --parameters "sku=$Sku" `
  --query properties.outputs -o json | ConvertFrom-Json

Write-Host ''
Write-Host "Speech resource : $($out.name.value) ($($out.region.value))"
Write-Host "Resource id     : $($out.id.value)"
Write-Host 'Apps pick it up with their own deploy (Retrolash: ./infra/deploy.ps1 finds it automatically).'
