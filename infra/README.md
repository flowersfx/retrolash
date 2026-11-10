# Retrolash on Azure

## What gets created

All in one resource group (default `rg-retrolash`, Sweden Central):

| Resource | Purpose | Expected cost |
|---|---|---|
| Container Apps environment (Consumption profile) | Hosts the app. No Log Analytics workspace, to avoid log charges. | $0 |
| Container app `retrolash`: 0.25 vCPU / 0.5 GiB, 0–1 replicas | Web app + game server. Scales to zero when idle. | Likely $0: the monthly free allowance per subscription (180,000 vCPU-s, 360,000 GiB-s, 2M requests) is ~200 h of running time at this size |
| Storage account (Standard LRS) + 1 GiB Azure Files share | Saved games, so restarts resume | Cents per month |

Optional, in a separate shared resource group (`rg-lab-shared`): an Azure AI Speech account (free F0) for spoken prompts, shared with other lab prototypes. See step 4.

The image comes from GitHub Container Registry (`ghcr.io/flowersfx/retrolash`), which is free for public packages. No Azure Container Registry is needed.

Prices and SLAs change. Check the [Container Apps pricing page](https://azure.microsoft.com/pricing/details/container-apps/) and the Azure SLA documents before quoting them to anyone.

**Visual Studio (MSDN) subscription:** its Azure credit is meant for dev/test. Check the terms, or ask Valtech IT, before running real team retros on it long-term, and move it to a Valtech subscription if other teams start using it.

## One-time setup

### 1. Log in to the right subscription

`az login` adds accounts and tenants. It doesn't log you out of others. The scripts always pass `--subscription`, so your az default is never used.

```powershell
az login --tenant <tenant-id-of-your-visual-studio-subscription>
az account list --query "[].{name:name, id:id}" -o table   # find the Visual Studio subscription id
```

To find the tenant: sign in at https://portal.azure.com with the account you use for my.visualstudio.com, open **Subscriptions**, pick the Visual Studio subscription, and look at the directory it belongs to (**Switch directory** shows the tenant id). If the subscription belongs to a different Microsoft account, run `az login` and sign in with that account instead.

### 2. Make the container image public

After the first push to `main`, GitHub Actions publishes `ghcr.io/flowersfx/retrolash`. If the package shows as private, open it under the flowersfx org's **Packages** tab, then **Package settings** and **Change visibility** → Public, so Azure can pull it without credentials.

### 3. Create the Azure resources

```powershell
./infra/deploy.ps1 -SubscriptionId <id> -PreviewOnly   # what-if only, changes nothing
./infra/deploy.ps1 -SubscriptionId <id>                # asks before creating anything
```

It prints the app URL at the end (`https://retrolash.<something>.swedencentral.azurecontainerapps.io`). Re-running it is safe; it shows the diff each time.

Options: `-MinReplicas 1` keeps it always warm (no cold start, costs more), `-Location westeurope`, `-ResourceGroup <name>`.

### 4. Optional: spoken prompts (shared lab Speech)

The big screen can read round titles and prompts aloud with Azure AI Speech neural voices. The Speech resource is **shared by lab prototypes** in this subscription, so it lives in its own resource group (`rg-lab-shared`), not in `rg-retrolash`:

```powershell
./infra/lab/deploy-speech.ps1 -SubscriptionId <id> -PreviewOnly   # what-if only
./infra/lab/deploy-speech.ps1 -SubscriptionId <id>                # registers the provider, creates rg-lab-shared + speech-lab-<suffix>
./infra/deploy.ps1 -SubscriptionId <id>                           # finds it and wires it into Retrolash
```

- **Tier:** free (F0): 0.5 M neural characters a month, with request-rate limits, **shared by every app** that uses it. A subscription can only have one F0 Speech resource. Use `-Sku S0` for pay-as-you-go. Check the [pricing page](https://azure.microsoft.com/pricing/details/cognitive-services/speech-services/) first.
- **Key handling:** `infra/main.bicep` reads the key with `listKeys()` at deploy time and stores it as the Container Apps secret `speech-key`. Nobody copies it by hand, and it never appears in the repo or in GitHub. Rotating the key (`az cognitiveservices account keys regenerate`) breaks every app until each one is redeployed. Moving consumers to managed identity + the *Cognitive Services Speech User* role is the cleaner next step; the account already has the custom subdomain that needs.
- **Caching:** clips are generated on demand and stored in the Azure Files share (`/data/tts`). Built-in prompts are kept for good; custom prompts are deleted with the saved games (24 h).
- **Data:** the text of custom prompts is sent to Azure Speech in this subscription.
- **Without it:** `./infra/deploy.ps1 -NoSpeech`, or simply don't create the shared resource. The game runs silent and the lobby hides the toggle.

### 5. Optional: automatic rollouts from GitHub

```powershell
./infra/setup-github-oidc.ps1 -SubscriptionId <id>
```

This creates an app registration that trusts **only** GitHub Actions runs on `main` of `flowersfx/retrolash` (OIDC, no client secret) and gives it Contributor on **the container app only**. Add the four values it prints as GitHub **repository variables**. From then on, every push to `main` deploys the new image.

Without this step, roll out a new version by hand after CI has pushed the image:

```powershell
az containerapp update -n retrolash -g rg-retrolash --subscription <id> --image ghcr.io/flowersfx/retrolash:<git-sha>
```

## Operating

- **Logs:** `az containerapp logs show -n retrolash -g rg-retrolash --subscription <id> --follow`
- **Cold start:** after it has scaled to zero, the first page load can take several seconds to tens of seconds. Open the big screen a minute before the retro.
- **Saved games** are deleted after 24 h (`roomTtlHours` parameter). Retro answers can contain client or project details, so keep this short.
- **Remove everything:** `az group delete -n rg-retrolash --subscription <id>` deletes all of it, including saved games.

## Known limits

- One replica by design (rooms live in memory). Fine for a handful of simultaneous retros.
- Not yet verified on Azure: whether an open WebSocket with little traffic keeps the replica from scaling to zero mid-game. Saved state makes a restart resume, but if it happens, redeploy with `-MinReplicas 1`.
