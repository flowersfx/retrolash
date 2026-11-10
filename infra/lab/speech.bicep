// Shared Azure AI Speech for lab prototypes in this subscription (not just Retrolash).
// Lives in its own resource group (default rg-lab-shared) so apps can come and go.
//
// A subscription can only have one free (F0) Speech resource, and F0 has a shared
// monthly quota and request-rate limits across every app that uses it.
// Apps read the key at deploy time (listKeys in their own template) and keep it
// as a secret; the key never needs to be copied by hand.
//
// Preview:  az deployment group what-if -g rg-lab-shared --subscription <sub> -f infra/lab/speech.bicep
// Deploy:   ./infra/lab/deploy-speech.ps1 -SubscriptionId <sub>

@description('Azure region. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('F0 = free tier (0.5 M neural TTS characters a month, rate-limited). S0 = pay as you go.')
@allowed(['F0', 'S0'])
param sku string = 'F0'

var name = 'speech-lab-${uniqueString(resourceGroup().id)}'

resource speech 'Microsoft.CognitiveServices/accounts@2023-05-01' = {
  name: name
  location: location
  kind: 'SpeechServices'
  sku: { name: sku }
  tags: {
    purpose: 'lab-shared'
    note: 'Shared by lab prototypes. Rotating keys or changing the tier affects all of them.'
  }
  properties: {
    // A custom subdomain is required for Microsoft Entra ID (managed identity) auth,
    // which is the planned upgrade from keys.
    customSubDomainName: name
    publicNetworkAccess: 'Enabled'
    // Keys stay on until every consumer has moved to managed identity.
    disableLocalAuth: false
  }
}

output id string = speech.id
output name string = speech.name
output region string = speech.location
