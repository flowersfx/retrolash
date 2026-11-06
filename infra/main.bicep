// Retrolash on Azure Container Apps (consumption, scale to zero).
// Everything lives in one resource group:
//   - Container Apps environment (Consumption workload profile, no Log Analytics)
//   - Storage account + Azure Files share, mounted at /data for saved games
//   - The container app itself: 0..1 replicas, external HTTPS ingress
//
// Preview:  az deployment group what-if  -g <rg> --subscription <sub> -f infra/main.bicep
// Deploy:   az deployment group create   -g <rg> --subscription <sub> -f infra/main.bicep

@description('Azure region. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('Container image to run.')
param image string = 'ghcr.io/flowersfx/retrolash:latest'

@description('0 = scale to zero when idle (cheapest, cold start on first visit). 1 = always warm.')
@allowed([0, 1])
param minReplicas int = 0

@description('Saved games older than this many hours are deleted.')
param roomTtlHours int = 24

var name = 'retrolash'
var storageName = take('retrolash${uniqueString(resourceGroup().id)}', 24)
var shareName = 'data'
var envStorageName = 'gamedata'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    // Container Apps mounts Azure Files with the account key.
    allowSharedKeyAccess: true
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: shareName
  properties: {
    shareQuota: 1 // GiB; saved games are a few KB each
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-env'
  location: location
  properties: {
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource envStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: env
  name: envStorageName
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: share.name
      accessMode: 'ReadWrite'
    }
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  properties: {
    managedEnvironmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto' // HTTP/1.1 with WebSocket upgrade
        allowInsecure: false
      }
    }
    template: {
      containers: [
        {
          name: name
          image: image
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            { name: 'ROOM_TTL_HOURS', value: string(roomTtlHours) }
          ]
          volumeMounts: [
            { volumeName: 'data', mountPath: '/data' }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 8080 }
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: 8080 }
              periodSeconds: 10
            }
          ]
        }
      ]
      // Room state is in memory, so never run more than one replica.
      scale: {
        minReplicas: minReplicas
        maxReplicas: 1
        rules: [
          {
            name: 'http'
            http: { metadata: { concurrentRequests: '100' } }
          }
        ]
      }
      volumes: [
        {
          name: 'data'
          storageType: 'AzureFile'
          storageName: envStorage.name
          // The image runs as the non-root "node" user (uid/gid 1000).
          mountOptions: 'uid=1000,gid=1000,dir_mode=0750,file_mode=0640'
        }
      ]
    }
  }
}

output url string = 'https://${app.properties.configuration.ingress.fqdn}'
output appName string = app.name
