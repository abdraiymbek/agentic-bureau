// STARK fixture: removable camera tray for the inspection rover.
// Parametric: sized from payload width; changes when the payload
// requirement changes. All dimensions in millimetres.

// --- parameters (overridable with -D on the OpenSCAD command line) ---
tray_width    = 62;    // mm — payload bay width
tray_depth    = 44;    // mm — front-to-back
tray_thick    = 2.5;   // mm — plate thickness
wall_h        = 12;    // mm — side wall height
wall_t        = 2.0;   // mm — wall thickness
cam_slot_w    = 25;    // mm — camera module slot (Pi Camera Module 3)
cam_slot_d    = 9;     // mm — slot depth into the plate
hole_d        = 2.5;   // mm — M2.5 mounting hole diameter
hole_inset    = 4;     // mm — hole inset from tray corners
chamfer       = 0.6;   // mm — edge chamfer on the plate

module plate() {
    difference() {
        // base plate with corner chamfers
        hull() {
            for (x = [chamfer, tray_width - chamfer])
                for (y = [chamfer, tray_depth - chamfer])
                    translate([x, y, 0])
                        cylinder(r = chamfer, h = tray_thick, $fn = 16);
        }
        // camera slot, centered front edge
        translate([(tray_width - cam_slot_w) / 2, -1, -1])
            cube([cam_slot_w, cam_slot_d + 1, tray_thick + 2]);
        // four M2.5 mounting holes
        for (x = [hole_inset, tray_width - hole_inset])
            for (y = [hole_inset, tray_depth - hole_inset])
                translate([x, y, -1])
                    cylinder(d = hole_d, h = tray_thick + 2, $fn = 24);
    }
}

module walls() {
    // left/right retaining walls
    for (x = [0, tray_width - wall_t])
        translate([x, 0, tray_thick])
            cube([wall_t, tray_depth, wall_h]);
    // rear wall
    translate([0, tray_depth - wall_t, tray_thick])
        cube([tray_width, wall_t, wall_h]);
}

plate();
walls();
