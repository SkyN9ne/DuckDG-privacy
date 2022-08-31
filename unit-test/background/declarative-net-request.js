import '../helpers/mock-browser-api'
import * as allowlistedTrackers from '../data/reference-tests/tracker-radar-tests/TR-domain-matching/tracker_allowlist_reference.json'
import * as tds from '../data/tds.json'
import * as browserWrapper from '../../shared/js/background/wrapper.es6'
import * as testConfig from '../data/extension-config.json'
import * as tdsStorageStub from '../helpers/tds.es6'
import settings from '../../shared/js/background/settings.es6'

const TEST_ETAGS = ['flib', 'flob', 'cabbage']
const TEST_EXTENION_VERSIONS = ['0.1', '0.2', '0.3']

let SETTING_PREFIX
let getMatchDetails
let onUpdateListeners

// Set up the extension configuration to ensure that tracker allowlisting is
// enabled for the right domains.
const config = JSON.parse(JSON.stringify(testConfig))
config.features.trackerAllowlist = {
    state: 'enabled',
    settings: { allowlistedTrackers }
}

const expectedRuleIdsByConfigName = {
    tds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    config: [10001, 10002, 10003, 10004, 10005, 10006]
}

const expectedLookupByConfigName = {
    tds: [
        undefined, undefined, 'facebook.com,facebook.net',
        'google-analytics.com', 'google-analytics.com', 'google-analytics.com',
        'google-analytics.com', 'google-analytics.com', 'google-analytics.com',
        'google-analytics.com', 'yahoo.com'
    ],
    config: {
        10002: {
            type: 'trackerAllowlist',
            domain: 'allowlist-tracker-1.com',
            reason: 'match single resource on single site'
        },
        10003: {
            type: 'trackerAllowlist',
            domain: 'allowlist-tracker-2.com',
            reason: 'match single resource on all sites'
        },
        10004: {
            type: 'trackerAllowlist',
            domain: 'allowlist-tracker-2.com',
            reason: 'match all sites and all paths'
        },
        10005: {
            type: 'trackerAllowlist',
            domain: 'allowlist-tracker-2.com',
            reason: 'specific subdomain rule'
        },
        10006: {
            type: 'trackerAllowlist',
            domain: 'allowlist-tracker-3.com',
            reason: 'match all requests'
        }
    }
}

async function updateConfiguration (configName, etag) {
    const configValue = { config, tds }[configName]
    const listeners = onUpdateListeners.get(configName)
    if (listeners) {
        await Promise.all(
            listeners.map(listener => listener(configName, etag, configValue))
        )
    }
}

describe('declarativeNetRequest', () => {
    let updateSettingObserver
    let updateDynamicRulesObserver

    let extensionVersion
    let settingsStorage
    let dynamicRulesByRuleId

    const expectState = (expectedSettings, expectedUpdateCallCount) => {
        const expectedRuleIds = new Set()
        for (const [configName, {
            etag: expectedEtag,
            extensionVersion: expectedExtensionVersion
        }] of Object.entries(expectedSettings)) {
            if (!expectedEtag) {
                continue
            }

            const setting =
                  settingsStorage.get(SETTING_PREFIX + configName) || {}

            const {
                etag: actualLookupEtag,
                lookup: actualLookup,
                extensionVersion: actualLookupExtensionVersion
            } = setting
            const etagRuleId = expectedRuleIdsByConfigName[configName][0]
            const etagRule = dynamicRulesByRuleId.get(etagRuleId)
            const actualRuleEtag = etagRule?.condition?.urlFilter

            expect(actualLookup).toEqual(expectedLookupByConfigName[configName])
            expect(actualRuleEtag).toEqual(expectedEtag)
            expect(actualLookupEtag).toEqual(expectedEtag)
            expect(actualLookupExtensionVersion)
                .toEqual(expectedExtensionVersion)

            for (const ruleId of expectedRuleIdsByConfigName[configName]) {
                expectedRuleIds.add(ruleId)
            }
        }

        expect(new Set(dynamicRulesByRuleId.keys())).toEqual(expectedRuleIds)

        expect(updateDynamicRulesObserver.calls.count())
            .toEqual(expectedUpdateCallCount)
        expect(updateSettingObserver.calls.count())
            .toEqual(expectedUpdateCallCount)
    }

    beforeAll(async () => {
        extensionVersion = TEST_EXTENION_VERSIONS[0]
        settingsStorage = new Map()
        dynamicRulesByRuleId = new Map()

        onUpdateListeners = tdsStorageStub.stub({ config }).onUpdateListeners

        spyOn(settings, 'getSetting').and.callFake(
            name => settingsStorage.get(name)
        )
        updateSettingObserver =
            spyOn(settings, 'updateSetting').and.callFake(
                (name, value) => {
                    settingsStorage.set(name, value)
                }
            )
        updateDynamicRulesObserver =
            spyOn(
                chrome.declarativeNetRequest,
                'updateDynamicRules'
            ).and.callFake(
                ({ removeRuleIds, addRules }) => {
                    if (removeRuleIds) {
                        for (const id of removeRuleIds) {
                            dynamicRulesByRuleId.delete(id)
                        }
                    }
                    if (addRules) {
                        for (const rule of addRules) {
                            if (dynamicRulesByRuleId.has(rule.id)) {
                                throw new Error('Duplicate rule ID: ' + rule.id)
                            }
                            dynamicRulesByRuleId.set(rule.id, rule)
                        }
                    }
                    return Promise.resolve()
                }
            )
        spyOn(chrome.declarativeNetRequest, 'getDynamicRules').and.callFake(
            () => Array.from(dynamicRulesByRuleId.values())
        )

        spyOn(browserWrapper, 'getExtensionVersion').and.callFake(
            () => extensionVersion
        )

        // Force manifest version to '3' before requiring the
        // declarativeNetRequest code to prevent the MV3 code paths from being
        // skipped.
        // Note: It would be better to use destructuring to assign
        //       getMatchDetails and SETTING_PREFIX, but that confuses ESLint.
        spyOn(browserWrapper, 'getManifestVersion').and.callFake(() => 3)
        const declarativeNetRequest =
              await import('../../shared/js/background/declarative-net-request')
        getMatchDetails = declarativeNetRequest.getMatchDetails
        SETTING_PREFIX = declarativeNetRequest.SETTING_PREFIX
    })

    beforeEach(() => {
        updateSettingObserver.calls.reset()
        updateDynamicRulesObserver.calls.reset()
        settingsStorage.clear()
        dynamicRulesByRuleId.clear()
    })

    it('Rule updates', async () => {
        expectState({
            tds: { etag: null, extensionVersion: null },
            config: { etag: null, extensionVersion: null }
        }, 0)

        // Nothing saved, tracker blocking rules should be added.
        await updateConfiguration('tds', TEST_ETAGS[0])
        expectState({
            tds: {
                etag: TEST_ETAGS[0], extensionVersion: TEST_EXTENION_VERSIONS[0]
            },
            config: {
                etag: null, extensionVersion: null
            }
        }, 1)

        // Rules for that ruleset are already present, skip.
        await updateConfiguration('tds', TEST_ETAGS[0])
        expectState({
            tds: {
                etag: TEST_ETAGS[0], extensionVersion: TEST_EXTENION_VERSIONS[0]
            },
            config: {
                etag: null, extensionVersion: null
            }
        }, 1)

        // Add configuration ruleset.
        await updateConfiguration('config', TEST_ETAGS[2])
        expectState({
            tds: {
                etag: TEST_ETAGS[0], extensionVersion: TEST_EXTENION_VERSIONS[0]
            },
            config: {
                etag: TEST_ETAGS[2], extensionVersion: TEST_EXTENION_VERSIONS[0]
            }
        }, 2)

        // Tracker blocking rules are outdated, replace with new ones.
        await updateConfiguration('tds', TEST_ETAGS[1])
        expectState({
            tds: {
                etag: TEST_ETAGS[1], extensionVersion: TEST_EXTENION_VERSIONS[0]
            },
            config: {
                etag: TEST_ETAGS[2], extensionVersion: TEST_EXTENION_VERSIONS[0]
            }
        }, 3)

        // Configuration ruleset already present, skip.
        await updateConfiguration('config', TEST_ETAGS[2])
        expectState({
            tds: {
                etag: TEST_ETAGS[1], extensionVersion: TEST_EXTENION_VERSIONS[0]
            },
            config: {
                etag: TEST_ETAGS[2], extensionVersion: TEST_EXTENION_VERSIONS[0]
            }
        }, 3)

        // Settings missing, add rules again.
        settingsStorage.clear()
        await updateConfiguration('tds', TEST_ETAGS[1])
        await updateConfiguration('config', TEST_ETAGS[2])
        expectState({
            tds: {
                etag: TEST_ETAGS[1], extensionVersion: TEST_EXTENION_VERSIONS[0]
            },
            config: {
                etag: TEST_ETAGS[2], extensionVersion: TEST_EXTENION_VERSIONS[0]
            }
        }, 5)

        // Rules missing, add tracker blocking rules again.
        dynamicRulesByRuleId.clear()
        await updateConfiguration('tds', TEST_ETAGS[1])
        await updateConfiguration('config', TEST_ETAGS[2])
        expectState({
            tds: {
                etag: TEST_ETAGS[1], extensionVersion: TEST_EXTENION_VERSIONS[0]
            },
            config: {
                etag: TEST_ETAGS[2], extensionVersion: TEST_EXTENION_VERSIONS[0]
            }
        }, 7)

        // All good again, skip.
        await updateConfiguration('tds', TEST_ETAGS[1])
        await updateConfiguration('config', TEST_ETAGS[2])
        expectState({
            tds: {
                etag: TEST_ETAGS[1], extensionVersion: TEST_EXTENION_VERSIONS[0]
            },
            config: {
                etag: TEST_ETAGS[2], extensionVersion: TEST_EXTENION_VERSIONS[0]
            }
        }, 7)

        // Extension has been updated, refresh rules again
        extensionVersion = TEST_EXTENION_VERSIONS[1]
        await updateConfiguration('tds', TEST_ETAGS[1])
        expectState({
            tds: {
                etag: TEST_ETAGS[1], extensionVersion: TEST_EXTENION_VERSIONS[1]
            },
            config: {
                etag: TEST_ETAGS[2], extensionVersion: TEST_EXTENION_VERSIONS[0]
            }
        }, 8)
        await updateConfiguration('config', TEST_ETAGS[2])
        expectState({
            tds: {
                etag: TEST_ETAGS[1], extensionVersion: TEST_EXTENION_VERSIONS[1]
            },
            config: {
                etag: TEST_ETAGS[2], extensionVersion: TEST_EXTENION_VERSIONS[1]
            }
        }, 9)

        // All good again, skip.
        await updateConfiguration('tds', TEST_ETAGS[1])
        await updateConfiguration('config', TEST_ETAGS[2])
        expectState({
            tds: {
                etag: TEST_ETAGS[1], extensionVersion: TEST_EXTENION_VERSIONS[1]
            },
            config: {
                etag: TEST_ETAGS[2], extensionVersion: TEST_EXTENION_VERSIONS[1]
            }
        }, 9)
    })

    it('getMatchDetails', async () => {
        // No rules, so no match details.
        // - Tracker blocking:
        for (let i = 0; i < expectedLookupByConfigName.tds.length; i++) {
            if (!expectedLookupByConfigName.tds[i]) continue
            expect(await getMatchDetails(i)).toEqual({ type: 'unknown' })
        }
        // - Extension configuration:
        for (let i in expectedLookupByConfigName.config) {
            i = parseInt(i, 10)
            expect(await getMatchDetails(i)).toEqual({ type: 'unknown' })
        }

        // Add the tracker blocking rules.
        await updateConfiguration('tds', TEST_ETAGS[0])

        // Still should not be any match details for the extension configuration
        // yet.
        for (let i in expectedLookupByConfigName.config) {
            i = parseInt(i, 10)
            expect(await getMatchDetails(i)).toEqual({ type: 'unknown' })
        }

        // But there should be tracker blocking match details now.
        for (let i = 0; i < expectedLookupByConfigName.tds.length; i++) {
            if (!expectedLookupByConfigName.tds[i]) continue
            expect(await getMatchDetails(i)).toEqual({
                type: 'trackerBlocking',
                possibleTrackerDomains:
                    expectedLookupByConfigName.tds[i].split(',')
            })
        }

        // Add the extension configuration rules.
        await updateConfiguration('config', TEST_ETAGS[1])

        // Extension configuration match details should now show up.
        for (let i in expectedLookupByConfigName.config) {
            i = parseInt(i, 10)
            expect(await getMatchDetails(i)).toEqual(
                expectedLookupByConfigName.config[i]
            )
        }

        // Tracker blocking match details should still be there too.
        for (let i = 0; i < expectedLookupByConfigName.tds.length; i++) {
            if (!expectedLookupByConfigName.tds[i]) continue
            expect(await getMatchDetails(i)).toEqual({
                type: 'trackerBlocking',
                possibleTrackerDomains:
                    expectedLookupByConfigName.tds[i].split(',')
            })
        }
    })
})