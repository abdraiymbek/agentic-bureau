$fn = 64;

// Primary envelope
foot_x = 40;
foot_y = 30;
top_z_at_x0 = 20;
top_z_at_x40 = 10;

// Drilled feature
hole_d = 6;
hole_x = 20;
hole_y = 15;
hole_z = 15;

// Inclined top: z = top_z_at_x0 - x * (top_z_at_x0 - top_z_at_x40) / foot_x
slope_drop = top_z_at_x0 - top_z_at_x40;
top_slope = slope_drop / foot_x;
hole_axis_tilt_deg = atan2(-1, -1 / top_slope);

module wedge() {
    // Extruded x-z side profile, spanning y = 0..foot_y.
    // Rotate the default +Z extrusion onto -Y and shift it to y=0..foot_y.
    translate([0, foot_y, 0])
        rotate([90, 0, 0])
            linear_extrude(height = foot_y)
            polygon([
                [0, 0],
                [foot_x, 0],
                [foot_x, top_z_at_x40],
                [0, top_z_at_x0]
            ]);
}

module inclined_hole() {
    // Axis is perpendicular to the top plane, directed into the part.
    // The cylinder is centered on the requested entry point and overlong
    // so it cuts completely through the bottom face.
    translate([hole_x, hole_y, hole_z])
        rotate([0, hole_axis_tilt_deg, 0])
            cylinder(h = 40, d = hole_d, center = true);
}

difference() {
    wedge();
    inclined_hole();
}