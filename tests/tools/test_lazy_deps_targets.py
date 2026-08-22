"""only_targets — the target gate behind bundled staging.

A wheel gap belongs to a (platform, arch) pair, and it costs different
things to different askers: a user machine cannot compile, the bundled
build lane can. These tests pin that split and the two queries the
staging script drives.

current_target() is the single seam every gate reads, so patching it
simulates a build target honestly — no sys.platform faking, and every
target is covered from whichever host runs the suite.
"""

from unittest.mock import patch

import pytest

from tools import lazy_deps as ld


def at(target: str):
    """Run a block as if this host were ``target``."""
    return patch("installation.registry.current_target", return_value=target)


class TestTargetKeyExpansion:
    def test_a_platform_key_covers_every_target_of_that_platform(self):
        table = ld._expand_target_keys({"darwin": ld.UNAVAILABLE})
        assert table == {
            "darwin-x64": ld.UNAVAILABLE,
            "darwin-arm64": ld.UNAVAILABLE,
        }

    def test_target_and_platform_keys_mix(self):
        table = ld._expand_target_keys(
            {"linux": ld.BUILD_WHEEL, "win32-arm64": ld.UNAVAILABLE}
        )
        assert table["linux-x64"] == ld.BUILD_WHEEL
        assert table["linux-arm64"] == ld.BUILD_WHEEL
        assert table["win32-arm64"] == ld.UNAVAILABLE
        assert "win32-x64" not in table

    def test_an_unknown_key_raises_rather_than_gating_nothing(self):
        # A typo that silently matched no target would look like a
        # working gate and ship the broken combination.
        with pytest.raises(ValueError, match="matches no target"):
            ld._expand_target_keys({"windows": ld.UNAVAILABLE})

    def test_an_unknown_verdict_raises(self):
        with pytest.raises(ValueError, match="expected"):
            ld._expand_target_keys({"linux": "maybe"})


class TestVerdictSemantics:
    """UNAVAILABLE refuses everyone; BUILD_WHEEL refuses only the user."""

    def test_unavailable_refuses_runtime_and_bundle_alike(self):
        probe = ld.only_targets({"darwin-x64": ld.UNAVAILABLE}, "no sdist exists.")
        with at("darwin-x64"):
            with pytest.raises(ld.UnsupportedFeature, match="darwin-x64"):
                probe()
            with pytest.raises(ld.UnsupportedFeature):
                probe(for_bundle=True)

    def test_build_wheel_refuses_the_user_and_allows_the_build_lane(self):
        probe = ld.only_targets({"win32-arm64": ld.BUILD_WHEEL}, "no wheel published.")
        with at("win32-arm64"):
            with pytest.raises(ld.UnsupportedFeature, match="does not compile"):
                probe()
            probe(for_bundle=True)  # the lane compiles the sdist

    def test_an_unlisted_target_is_untouched(self):
        probe = ld.only_targets({"win32-arm64": ld.UNAVAILABLE})
        with at("linux-x64"):
            probe()
            probe(for_bundle=True)

    def test_the_explainer_reaches_the_user(self):
        probe = ld.only_targets({"linux-x64": ld.UNAVAILABLE}, "use the cloud backend.")
        with at("linux-x64"):
            with pytest.raises(ld.UnsupportedFeature, match="use the cloud backend"):
                probe()


class TestGatedFeatures:
    """The real LAZY_DEPS entries, at the targets their gaps are on."""

    @pytest.mark.parametrize(
        "feature,target",
        [
            ("stt.faster_whisper", "darwin-x64"),   # onnxruntime: no wheel, no sdist
            ("stt.faster_whisper", "win32-arm64"),  # ctranslate2: no wheel, no sdist
            ("wake.openwakeword", "darwin-x64"),    # onnxruntime again
            ("wake.openwakeword.tflite", "darwin-x64"),  # ai-edge-litert
        ],
    )
    def test_unavailable_features_are_never_staged(self, feature, target):
        with at(target):
            with pytest.raises(ld.UnsupportedFeature):
                ld.check_supported(feature, for_bundle=True)
            assert ld.feature_extra(feature) not in ld.bundle_extras()

    @pytest.mark.parametrize(
        "feature,target",
        [
            ("wake.sherpa", "win32-arm64"),
            ("terminal.daytona", "win32-arm64"),
            ("terminal.modal", "darwin-x64"),
            ("platform.dingtalk", "linux-x64"),
        ],
    )
    def test_build_wheel_features_ship_but_refuse_a_runtime_install(self, feature, target):
        with at(target):
            with pytest.raises(ld.UnsupportedFeature):
                ld.check_supported(feature)
            ld.check_supported(feature, for_bundle=True)
            assert ld.feature_extra(feature) in ld.bundle_extras()

    def test_a_feature_stays_available_on_the_arch_that_has_the_wheel(self):
        # The whole reason the gate is per-target: onnxruntime publishes
        # a macOS arm64 wheel, so gating the platform would have taken
        # the wake word away from Apple silicon.
        with at("darwin-arm64"):
            ld.check_supported("wake.openwakeword")
            assert "wake-openwakeword" in ld.bundle_extras()


class TestBundleQueries:
    """What the staging script asks, per target."""

    def test_every_target_stages_a_useful_set(self):
        for target in ld.ALL_TARGETS:
            with at(target):
                extras = ld.bundle_extras()
            assert len(extras) > 20, f"{target} staged only {len(extras)}"
            assert len(extras) == len(set(extras)), f"{target} repeated an extra"

    def test_source_builds_name_packages_of_staged_extras_only(self):
        for target in ld.ALL_TARGETS:
            with at(target):
                extras = set(ld.bundle_extras())
                builds = ld.bundle_source_builds()
                owners = {
                    ld._pkg_name_from_spec(spec)
                    for extra in extras
                    for spec in ld.extra_specs(extra)
                }
            assert set(builds) <= owners, f"{target}: {set(builds) - owners}"

    def test_a_target_with_no_gaps_asks_for_no_source_build(self):
        # win32-x64 is the target every gated package publishes a wheel
        # for, except dingtalk's sdist-only SDKs.
        with at("win32-x64"):
            builds = ld.bundle_source_builds()
        assert all("alibabacloud" in b or "dingtalk" in b or b == "qrcode" for b in builds), builds

    def test_the_two_queries_agree_about_what_is_staged(self):
        # A package can only be compiled for a bundle that carries it.
        for target in ld.ALL_TARGETS:
            with at(target):
                for feature in ld.LAZY_DEPS:
                    try:
                        ld.check_supported(feature, for_bundle=True)
                    except ld.UnsupportedFeature:
                        continue
                    assert ld.feature_extra(feature) in ld.bundle_extras() or not ld.extra_specs(
                        ld.feature_extra(feature)
                    )
